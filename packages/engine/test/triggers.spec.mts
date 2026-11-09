import { createHmac } from 'node:crypto'
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
import { deployThroughApi, testAppName } from './support/test-app.mts'
import { triggerEntry } from './support/trigger-entry.mts'

const signal = new AbortController().signal
const secret = 'correct horse battery staple'
const payload = { label: 'ai-fix', issue: { number: 12 } }

/** What the test app declares, besides its sandbox. */
const declared: Pick<WorkflowsDescription, 'workflows' | 'triggers'> = {
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

/** A schedule of fix-issue that ticks every second. */
const everySecond = {
	kind: 'schedule' as const,
	id: 'fix-issue * * * * * *',
	workflow: 'fix-issue',
	cron: '* * * * * *',
	parameters: { issue: 1 },
}

/** Long enough for an every-second schedule to tick twice. */
const moreThanTwoTicksMs = 2_500

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
	/** What the entry file does once it has started. Default: succeed. */
	readonly body?: string
	/** The triggers the app lists. Default: those in {@link declared}. */
	readonly triggers?: WorkflowsDescription['triggers']
	/** Changes what the backend does. */
	readonly wrap?: (backend: SandboxBackend) => SandboxBackend
}

/** An engine that serves webhooks, with the test app deployed and its webhook secrets set, closed when the test ends. */
async function serve({ body, triggers = declared.triggers, wrap = (backend) => backend }: ServeOptions = {}) {
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
	const served = await serveEngine({ home, backend, layout: hostSandboxLayout, webhooks: { port: 0 }, log, abortSignal: signal })
	const close = (pauseMs = 5_000) => served.close({ pause: AbortSignal.timeout(pauseMs), backend: AbortSignal.timeout(pauseMs * 2) })
	onTestFinished(() => close())
	await openWebhookSecrets(webhookSecretsFile(home)).set(testAppName, 'fix-issue', secret)
	await openWebhookSecrets(webhookSecretsFile(home)).set(testAppName, 'signed', secret)
	const client = controlClient(served.socketPath)
	await deployThroughApi(client, { main: triggerEntry(body) }, { workflows: declared.workflows, triggers })
	const deliver = (webhook: string, delivery: string, headers: Record<string, string>, app = testAppName) =>
		fetch(`${served.webhookUrl ?? ''}/webhooks/${app}/${webhook}`, {
			method: 'POST',
			body: delivery,
			headers: { 'content-type': 'application/json', ...headers },
		})
	return { served, client, created, log, deliver, close, home }
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
			app: { name: testAppName },
			trigger: { kind: 'webhook', id: 'fix-issue' },
			key: `webhook ${testAppName}/fix-issue/delivery-1`,
		})
		expect(await client.events(run, signal)).toEqual([
			expect.objectContaining({ trigger: { kind: 'webhook', id: 'fix-issue' }, input: payload }),
		])
		expect(await client.list(signal)).toHaveLength(1)
	})

	test('answer a payload that does not fit with a 4xx, before any sandbox is made for it', async () => {
		// Arrange
		const { client, deliver, created } = await serve()

		// Act
		const response = await deliver('fix-issue', JSON.stringify({ label: 'ai-fix' }), { 'x-webhook-secret': secret })

		// Assert
		expect(response.status).toBe(422)
		expect(await response.json()).toMatchObject({ problems: ["/ must have required property 'issue'"] })
		expect(created).not.toHaveBeenCalled()
		expect(await client.list(signal)).toEqual([])
	})

	test('refuse a delivery that is not signed with the secret, and make no sandbox for it', async () => {
		// Arrange
		const { client, deliver, log, created } = await serve()

		// Act
		const unsigned = await deliver('fix-issue', JSON.stringify(payload), {})
		const wrong = await deliver('fix-issue', JSON.stringify(payload), { 'x-webhook-secret': 'guess' })

		// Assert
		expect([unsigned.status, wrong.status]).toEqual([401, 401])
		expect(created).not.toHaveBeenCalled()
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

	test('answer 404 for a webhook the app does not have, and for an app that is not deployed', async () => {
		// Arrange
		const { home, deliver, log } = await serve()
		await openWebhookSecrets(webhookSecretsFile(home)).set(testAppName, 'deploy', secret)
		await openWebhookSecrets(webhookSecretsFile(home)).set('elsewhere', 'fix-issue', secret)

		// Act
		const unknownWebhook = await deliver('deploy', JSON.stringify(payload), { 'x-webhook-secret': secret })
		const unknownApp = await deliver('fix-issue', JSON.stringify(payload), { 'x-webhook-secret': secret }, 'elsewhere')

		// Assert
		expect([unknownWebhook.status, unknownApp.status]).toEqual([404, 404])
		expect(log).toHaveBeenCalledWith(expect.stringContaining('has no webhook deploy'))
		expect(log).toHaveBeenCalledWith(expect.stringContaining('there is no app elsewhere'))
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

	test("shut down while the sandbox of a delivery's run is never made", async () => {
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
		const delivery = await deliver('fix-issue', JSON.stringify(payload), { 'x-webhook-secret': secret })
		await creating.promise

		// Act
		const started = Date.now()
		await close(200)

		// Assert
		expect(delivery.status).toBe(202)
		expect(Date.now() - started).toBeLessThan(2_000)
	})
})

describe.skipIf(process.platform !== 'linux')('schedule triggers', () => {
	test('skip a tick while the previous run of the schedule is still going', async () => {
		// Arrange
		const waitsForever = `mailbox.send({ type: 'request', request: { kind: 'input', id: 'hold', question: 'Go on?', fields: {} } })\nawait mailbox.answer('hold', signal)`

		// Act
		const { client, log } = await serve({ body: waitsForever, triggers: [everySecond] })
		await vi.waitFor(
			() => {
				expect(log).toHaveBeenCalledWith(expect.stringContaining(`Skipped schedule ${testAppName}/fix-issue * * * * * *`))
			},
			{ timeout: 10_000, interval: 100 },
		)

		// Assert
		const runs = await client.list(signal)
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ app: { name: testAppName }, trigger: { kind: 'schedule', id: 'fix-issue * * * * * *' } })
	})

	test('start a schedule again once its previous run has ended', async () => {
		// Act
		const { client } = await serve({ triggers: [everySecond] })

		// Assert
		await vi.waitFor(
			async () => {
				const runs = await client.list(signal)
				expect(runs.filter((run) => run.status === 'succeeded').length).toBeGreaterThanOrEqual(2)
			},
			{ timeout: 10_000, interval: 100 },
		)
	})

	test('start nothing more once the app is removed', async () => {
		// Arrange
		const { client } = await serve({ triggers: [everySecond] })
		await vi.waitFor(
			async () => {
				expect(await client.list(signal)).not.toEqual([])
			},
			{ timeout: 10_000, interval: 100 },
		)

		// Act
		await client.removeApp(testAppName, signal)
		const afterRemoving = (await client.list(signal)).length
		await new Promise((resolve) => setTimeout(resolve, moreThanTwoTicksMs))

		// Assert
		expect((await client.list(signal)).length).toBe(afterRemoving)
	})

	test('fire a schedule by hand, with the parameters it is given', async () => {
		// Arrange
		const { client } = await serve({ triggers: [{ ...everySecond, id: 'fix-issue 0 0 1 1 *', cron: '0 0 1 1 *' }] })

		// Act
		const run = await client.startRun({
			app: testAppName,
			trigger: { kind: 'schedule', id: 'fix-issue 0 0 1 1 *' },
			input: { issue: 9 },
			abortSignal: signal,
		})
		await untilStatus(client, run.id, 'succeeded')

		// Assert
		expect(await client.events(run.id, signal)).toEqual([expect.objectContaining({ input: { issue: 9 } })])
	})
})
