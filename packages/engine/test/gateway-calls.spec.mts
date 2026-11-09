import { existsSync } from 'node:fs'
import path from 'node:path'
import { hostTool, keyFile, openCredentialStore, openGateway, openProviderSettings, type HostTool } from '@mesh-flow/gateway'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { openAppStore } from '../src/apps/app-store.mts'
import { Engine } from '../src/engine/engine.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { deployTestApp, runtimeScript, userRun } from './support/test-app.mts'

const abortSignal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(5_000), backend: AbortSignal.timeout(10_000) })

const echo = hostTool({ name: 'echo', input: z.object({ text: z.string() }) }, ({ text }) => Promise.resolve(`echo: ${text}`))

/** Started and never settles, until its call is stopped. */
const started = vi.fn()
const never = hostTool({ name: 'never', input: z.object({}) }, () => {
	started()
	return new Promise<never>(() => undefined)
})

/** An engine on the host backend with a gateway that has `tools`, closed when the test ends. */
async function openEngine({ home, tools = [echo, never] }: { readonly home?: string; readonly tools?: readonly HostTool[] } = {}) {
	onTestFinished(() => {
		started.mockClear()
	})
	const directory = home ?? (await temporaryDirectory())
	const gatewayHome = path.join(directory, 'gateway')
	const gateway = openGateway({
		home: gatewayHome,
		credentials: openCredentialStore(path.join(gatewayHome, 'credentials.json'), keyFile(path.join(gatewayHome, 'store.key'))),
		providers: openProviderSettings(path.join(gatewayHome, 'providers.json')),
		tools,
	})
	const backend = hostBackend(path.join(directory, 'sandboxes'))
	const apps = await openAppStore(path.join(directory, 'apps'), abortSignal)
	const log = vi.fn<(message: string) => void>()
	const engine = await Engine.open(
		{ backend, store: openRunStore(path.join(directory, 'runs')), apps, gateway, layout: hostSandboxLayout, log },
		abortSignal,
	)
	onTestFinished(() => engine.close(deadlines()))
	return { engine, apps, log, home: directory, gatewayHome }
}

async function untilStatus(engine: Engine, id: string, status: RunStatus): Promise<RunRecord> {
	return vi.waitFor(
		() => {
			const record = engine.get(id)
			if (record.status !== status) throw new Error(`Run is ${record.status}${record.error ? `: ${record.error}` : ''}`)
			return record
		},
		{ timeout: 20_000, interval: 50 },
	)
}

/** A runtime that takes its grant and calls the gateway with `call(id, call, token)`, which resolves to the answer's value. */
function callingScript(body: string): string {
	return runtimeScript(`
const grant = await mailbox.takeGrant(signal)
const call = async (id, gatewayCall, token) => {
	mailbox.send({ type: 'call', id, endpoint: grant.endpoint, token, call: gatewayCall })
	return (await mailbox.take(id, signal)).value
}
${body}
`)
}

/** The model of the app {@link deployModelApp} deploys. */
const appModel = 'claude-opus-5-5'

/** Deploys an app whose agents use {@link appModel} and whose one workflow succeeds at once. */
function deployModelApp(apps: Awaited<ReturnType<typeof openEngine>>['apps']) {
	return deployTestApp(apps, { calls: runtimeScript(`mailbox.send({ type: 'succeeded' })`) }, { models: [appModel] })
}

/** Adds a provider `work` that serves {@link appModel}, with `key` when one is given. */
async function withProvider(gatewayHome: string, key?: string) {
	await openProviderSettings(path.join(gatewayHome, 'providers.json')).put({ name: 'work', kind: 'anthropic' }, abortSignal)
	if (key === undefined) return
	const credentials = openCredentialStore(path.join(gatewayHome, 'credentials.json'), keyFile(path.join(gatewayHome, 'store.key')))
	await credentials.set('provider/work', key, abortSignal)
}

describe.skipIf(process.platform !== 'linux')('gateway calls', () => {
	test('runs host tools for the runtime, each call on the token the last answer handed out', async () => {
		// Arrange
		const { engine, apps, gatewayHome } = await openEngine()
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
const first = await call('call-1', { type: 'tool', tool: 'echo', input: { text: 'one' } }, grant.tokens[0])
const second = await call('call-2', { type: 'tool', tool: 'echo', input: { text: 'two' } }, first.next)
event('done', 'called', { results: [first.outcome.result, second.outcome.result] })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['echo'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		expect(await engine.events(run.id)).toEqual([expect.objectContaining({ results: ['echo: one', 'echo: two'] })])
		expect(existsSync(path.join(gatewayHome, 'runs', `${run.id}.json`))).toBe(false)
	})

	test("refuses a tool the app doesn't list", async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
const answer = await call('call-1', { type: 'tool', tool: 'never', input: {} }, grant.tokens[0])
event('done', 'called', { outcome: answer.outcome })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['echo'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		expect(await engine.events(run.id)).toEqual([
			expect.objectContaining({ outcome: { ok: false, error: "never isn't one of the tools of this endpoint." } }),
		])
		expect(started).not.toHaveBeenCalled()
	})

	test('stops a call the runtime cancels, and still answers it with the next token', async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
mailbox.send({ type: 'call', id: 'call-1', endpoint: grant.endpoint, token: grant.tokens[0], call: { type: 'tool', tool: 'never', input: {} } })
await new Promise((resolve) => setTimeout(resolve, 300))
mailbox.send({ type: 'cancel', id: 'call-1' })
const answer = (await mailbox.take('call-1', signal)).value
const next = await call('call-2', { type: 'tool', tool: 'echo', input: { text: 'after' } }, answer.next)
event('done', 'called', { first: answer.outcome, second: next.outcome })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['echo', 'never'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		expect(await engine.events(run.id)).toEqual([
			expect.objectContaining({
				first: { ok: false, error: 'The call was stopped: The runtime cancelled the call.' },
				second: { ok: true, result: 'echo: after' },
			}),
		])
	})

	test('stops a call whose cancel comes in the same read as the call', async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
mailbox.send({ type: 'call', id: 'call-1', endpoint: grant.endpoint, token: grant.tokens[0], call: { type: 'tool', tool: 'never', input: {} } })
mailbox.send({ type: 'cancel', id: 'call-1' })
const answer = (await mailbox.take('call-1', signal)).value
event('done', 'called', { first: answer.outcome })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['never'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		expect(await engine.events(run.id)).toEqual([
			expect.objectContaining({ first: { ok: false, error: 'The call was stopped: The runtime cancelled the call.' } }),
		])
	})

	test('fails the run when a spent token comes again', async () => {
		// Arrange
		const { engine, apps, log } = await openEngine()
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
await call('call-1', { type: 'tool', tool: 'echo', input: { text: 'one' } }, grant.tokens[0])
mailbox.send({ type: 'call', id: 'call-2', endpoint: grant.endpoint, token: grant.tokens[0], call: { type: 'tool', tool: 'echo', input: { text: 'stolen' } } })
await new Promise(() => {})
`),
			},
			{ tools: ['echo'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		const failed = await untilStatus(engine, run.id, 'failed')

		// Assert
		expect(failed.error).toContain('Someone else has the run')
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Someone else has the run'))
	})

	test('shuts down while a host tool never settles, and answers the call as interrupted after a resume', async () => {
		// Arrange
		const first = await openEngine()
		await deployTestApp(
			first.apps,
			{
				calls: callingScript(`
const answer = await call('call-1', { type: 'tool', tool: 'never', input: {} }, grant.tokens[0])
const next = await call('call-2', { type: 'tool', tool: 'echo', input: { text: 'after' } }, answer.next)
event('done', 'called', { first: answer.outcome, second: next.outcome })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['echo', 'never'] },
		)
		const run = await first.engine.startRun({ ...userRun('calls'), abortSignal })
		await vi.waitFor(() => {
			expect(started).toHaveBeenCalled()
		})

		// Act
		await first.engine.close(deadlines())
		const second = await openEngine({ home: first.home })
		await second.engine.resume(run.id, abortSignal)
		await untilStatus(second.engine, run.id, 'succeeded')

		// Assert
		const [done] = await second.engine.events(run.id)
		expect(done).toMatchObject({ first: { ok: false }, second: { ok: true, result: 'echo: after' } })
		expect(JSON.stringify(done)).toContain('engine stopped')
	})

	test("refuses a run before its sandbox when no provider serves the app's models", async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		await deployModelApp(apps)

		// Act
		const refused = engine.startRun({ ...userRun('calls'), abortSignal })

		// Assert
		await expect(refused).rejects.toMatchObject({ code: 'unavailable' })
		await expect(refused).rejects.toThrow('No model providers are set up')
		expect(engine.list()).toEqual([])
	})

	test("refuses a run when the provider of the app's model has no key", async () => {
		// Arrange
		const { engine, apps, gatewayHome } = await openEngine()
		await deployModelApp(apps)
		await withProvider(gatewayHome)

		// Act
		const refused = engine.startRun({ ...userRun('calls'), abortSignal })

		// Assert
		await expect(refused).rejects.toThrow('mesh-flow provider key work')
	})

	test("starts a run once a provider with a key serves the app's models", async () => {
		// Arrange
		const { engine, apps, gatewayHome } = await openEngine()
		await deployModelApp(apps)
		await withProvider(gatewayHome, 'sk-test')

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })

		// Assert
		await untilStatus(engine, run.id, 'succeeded')
	})
})
