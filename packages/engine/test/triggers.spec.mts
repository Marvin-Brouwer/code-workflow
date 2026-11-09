import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkflowsDescription } from '@mesh-flow/protocol'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { controlClient } from '../src/control/control-client.mts'
import type { RunRecord } from '../src/runs/run-record.mts'
import { serveEngine } from '../src/serve/serve-engine.mts'
import { openWebhookSecrets, webhookSecretsFile } from '../src/triggers/webhook-secrets.mts'
import { deferred } from './support/deferred.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { triggerEntry } from './support/trigger-entry.mts'
import { workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal
const secret = 'correct horse battery staple'
const payload = { label: 'ai-fix', issue: { number: 12 } }

const description: WorkflowsDescription = {
	workflows: [{ name: 'fix-issue', parameters: { type: 'object', properties: { issue: { type: 'number' } }, required: ['issue'] } }],
	triggers: [
		{ kind: 'user', id: 'fix-issue', workflow: 'fix-issue' },
		{
			kind: 'webhook',
			id: 'fix-issue',
			workflow: 'fix-issue',
			payload: {
				type: 'object',
				properties: { label: { type: 'string' }, issue: { type: 'object', required: ['number'] } },
				required: ['label', 'issue'],
			},
			signature: { scheme: 'secret-header', header: 'x-webhook-secret' },
			deliveryHeader: 'x-delivery',
		},
		{
			kind: 'webhook',
			id: 'signed',
			workflow: 'fix-issue',
			payload: { type: 'object' },
			signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
		},
	],
}

/** What the ingress answers for a delivery it took. */
const Accepted = z.object({ run: z.string(), status: z.string() })

/** The run a delivery started or reused. */
async function runOf(response: Response): Promise<string> {
	return Accepted.parse(await response.json()).run
}

/** Headers with the HMAC signature of `body`, as GitHub sends it. */
function signed(body: string): Record<string, string> {
	return { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }
}

interface ServeOptions {
	/** The entry file. Default: one with {@link description}. */
	readonly entry?: string
	/** Changes what the backend does. */
	readonly wrap?: (backend: SandboxBackend) => SandboxBackend
}

/** An engine that serves webhooks for one registered repository, `team`, closed when the test ends. */
async function serve({ entry = triggerEntry(description), wrap = (backend) => backend }: ServeOptions = {}) {
	const home = await temporaryDirectory()
	const host = hostBackend(path.join(home, 'sandboxes'))
	const created = vi.fn()
	const backend = wrap({
		...host,
		create: (spec, createSignal) => {
			created()
			return host.create(spec, createSignal)
		},
	})
	const log = vi.fn<(message: string) => void>()
	const served = await serveEngine({ home, backend, layout: hostSandboxLayout, webhooks: { port: 0 }, scheduleRefreshMs: 200, log, signal })
	const close = (pauseMs = 5_000) => served.close({ pause: AbortSignal.timeout(pauseMs), backend: AbortSignal.timeout(pauseMs * 2) })
	onTestFinished(() => close())
	const directory = await workflowRepository({ main: entry })
	const client = controlClient(served.socketPath)
	await client.addRepository({ name: 'team', directory }, signal)
	await openWebhookSecrets(webhookSecretsFile(home)).set('team', 'fix-issue', secret)
	await openWebhookSecrets(webhookSecretsFile(home)).set('team', 'signed', secret)
	const deliver = (webhook: string, body: string, headers: Record<string, string>) =>
		fetch(`${served.webhookUrl ?? ''}/webhooks/team/${webhook}`, {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/json', ...headers },
		})
	return { served, client, directory, created, log, deliver, close, home }
}

async function untilStatus(client: ReturnType<typeof controlClient>, id: string, status: RunRecord['status']): Promise<RunRecord> {
	return vi.waitFor(
		async () => {
			const record = await client.get(id, signal)
			if (record.status !== status) throw new Error(`Run is ${record.status}${record.error ? `: ${record.error}` : ''}`)
			return record
		},
		{ timeout: 20_000, interval: 50 },
	)
}

describe.skipIf(process.platform !== 'linux')('webhook triggers', () => {
	test('start a run for a signed delivery that fits, and reuse it for a redelivery', async () => {
		// Arrange
		const { client, deliver } = await serve()
		const headers = { 'x-webhook-secret': secret, 'x-delivery': 'delivery-1' }

		// Act
		const first = await deliver('fix-issue', JSON.stringify(payload), headers)
		const again = await deliver('fix-issue', JSON.stringify(payload), headers)

		// Assert
		expect(first.status).toBe(202)
		expect(again.status).toBe(200)
		const run = await runOf(first)
		expect(await runOf(again)).toBe(run)
		const record = await untilStatus(client, run, 'succeeded')
		expect(record).toMatchObject({
			trigger: { kind: 'webhook', id: 'fix-issue', repository: 'team' },
			key: 'webhook team/fix-issue/delivery-1',
		})
		expect(await client.events(run, signal)).toEqual([
			expect.objectContaining({ trigger: { kind: 'webhook', id: 'fix-issue' }, input: payload }),
		])
		expect(await client.list(signal)).toHaveLength(1)
	})

	test('answer a payload that does not fit with a 4xx, before any sandbox is made for it', async () => {
		// Arrange
		const { client, deliver, created, directory } = await serve()
		await client.describe(directory, signal)
		created.mockClear()

		// Act
		const response = await deliver('fix-issue', JSON.stringify({ label: 'ai-fix' }), { 'x-webhook-secret': secret })

		// Assert
		expect(response.status).toBe(422)
		expect(await response.json()).toMatchObject({ problems: ["/ must have required property 'issue'"] })
		expect(created).not.toHaveBeenCalled()
		expect(await client.list(signal)).toEqual([])
	})

	test('refuse a delivery that is not signed with the secret', async () => {
		// Arrange
		const { client, deliver, log } = await serve()

		// Act
		const unsigned = await deliver('fix-issue', JSON.stringify(payload), {})
		const wrong = await deliver('fix-issue', JSON.stringify(payload), { 'x-webhook-secret': 'guess' })

		// Assert
		expect([unsigned.status, wrong.status]).toEqual([401, 401])
		expect(await client.list(signal)).toEqual([])
		expect(log).toHaveBeenCalledWith(expect.stringContaining("isn't signed with the secret"))
	})

	test('check an HMAC signature of the body', async () => {
		// Arrange
		const { deliver } = await serve()
		const body = JSON.stringify(payload)

		// Act
		const fits = await deliver('signed', body, signed(body))
		const tampered = await deliver('signed', JSON.stringify({ ...payload, label: 'other' }), signed(body))

		// Assert
		expect(fits.status).toBe(202)
		expect(tampered.status).toBe(401)
	})

	test('name a delivery without a delivery header by its body', async () => {
		// Arrange
		const { deliver } = await serve()
		const body = JSON.stringify(payload)
		const otherBody = JSON.stringify({ ...payload, issue: { number: 13 } })

		// Act
		const first = await deliver('signed', body, signed(body))
		const same = await deliver('signed', body, signed(body))
		const other = await deliver('signed', otherBody, signed(otherBody))

		// Assert
		expect([first.status, same.status, other.status]).toEqual([202, 200, 202])
	})

	test('answer 404 for a webhook the entry file does not have', async () => {
		// Arrange
		const { home, deliver } = await serve()
		await openWebhookSecrets(webhookSecretsFile(home)).set('team', 'deploy', secret)

		// Act
		const response = await deliver('deploy', JSON.stringify(payload), { 'x-webhook-secret': secret })

		// Assert
		expect(response.status).toBe(404)
	})

	test('end a run as skipped when the schema in the sandbox turns the delivery down', async () => {
		// Arrange
		const { client, deliver } = await serve()

		// Act
		const response = await deliver('fix-issue', JSON.stringify({ ...payload, label: 'wontfix' }), { 'x-webhook-secret': secret })
		const run = await runOf(response)

		// Assert
		expect(response.status).toBe(202)
		const record = await untilStatus(client, run, 'skipped')
		expect(record.reason).toBe('The delivery is not for fix-issue: only ai-fix.')
		expect(record.error).toBeUndefined()
	})

	test('let the engine shut down while a delivery waits on a describe that never settles', async () => {
		// Arrange
		const creating = deferred<undefined>()
		const { deliver, close } = await serve({
			wrap: (backend) => ({
				...backend,
				create: () => {
					creating.resolve(undefined)
					return new Promise<never>(() => undefined)
				},
			}),
		})
		const delivery = deliver('fix-issue', JSON.stringify(payload), { 'x-webhook-secret': secret }).then(
			(response) => response.status,
			() => 'cut off',
		)
		await creating.promise
		const started = Date.now()

		// Act
		await close(200)

		// Assert
		expect(Date.now() - started).toBeLessThan(2_000)
		expect([503, 500, 'cut off']).toContain(await delivery)
	})
})

describe.skipIf(process.platform !== 'linux')('schedule triggers', () => {
	test('skip a tick while the previous run of the schedule is still going', async () => {
		// Arrange
		const everySecond = {
			...description,
			triggers: [
				{ kind: 'schedule' as const, id: 'fix-issue * * * * * *', workflow: 'fix-issue', cron: '* * * * * *', parameters: { issue: 1 } },
			],
		}
		const waitsForever = `mailbox.send({ type: 'request', request: { kind: 'input', id: 'hold', question: 'Go on?', fields: {} } })\nawait mailbox.answer('hold', signal)`

		// Act
		const { client, log } = await serve({ entry: triggerEntry(everySecond, waitsForever) })
		await vi.waitFor(
			() => {
				expect(log).toHaveBeenCalledWith(expect.stringContaining('Skipped schedule team/fix-issue * * * * * *'))
			},
			{ timeout: 10_000, interval: 100 },
		)

		// Assert
		const runs = await client.list(signal)
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ trigger: { kind: 'schedule', id: 'fix-issue * * * * * *', repository: 'team' } })
	})

	test('start a schedule again once its previous run has ended', async () => {
		// Arrange
		const everySecond = {
			...description,
			triggers: [{ kind: 'schedule' as const, id: 'fix-issue * * * * * *', workflow: 'fix-issue', cron: '* * * * * *' }],
		}

		// Act
		const { client } = await serve({ entry: triggerEntry(everySecond) })

		// Assert
		await vi.waitFor(
			async () => {
				const runs = await client.list(signal)
				expect(runs.filter((run) => run.status === 'succeeded').length).toBeGreaterThanOrEqual(2)
			},
			{ timeout: 10_000, interval: 100 },
		)
	})
})

describe.skipIf(process.platform !== 'linux')('describing an entry file', () => {
	test('happens once per version of the source, in a sandbox that is removed afterwards', async () => {
		// Arrange
		const { client, directory, created, served } = await serve()
		await client.describe(directory, signal)
		created.mockClear()

		// Act
		const again = await client.describe(directory, signal)
		await writeFile(path.join(directory, 'workflows', 'extra.mts'), '// changed\n')
		await client.describe(directory, signal)

		// Assert
		expect(again).toEqual(description)
		expect(created).toHaveBeenCalledOnce()
		expect(served.engine.list()).toEqual([])
	})
})
