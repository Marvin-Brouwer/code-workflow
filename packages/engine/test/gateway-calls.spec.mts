import { existsSync } from 'node:fs'
import path from 'node:path'
import {
	hostTool,
	keyFile,
	openCredentialStore,
	openGateway,
	openProviderSettings,
	SignInNeededError,
	type HostTool,
} from '@mesh-flow/gateway'
import type { Sandbox, SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { openAppStore } from '../src/apps/app-store.mts'
import type { ConnectorSettingsCheck } from '../src/engine/connector-settings-check.mts'
import { Engine } from '../src/engine/engine.mts'
import { openSignIns, type SignIns } from '../src/engine/sign-ins.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { deployTestApp, runtimeScript, userRun } from './support/test-app.mts'

const abortSignal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(5_000), backend: AbortSignal.timeout(10_000) })

/** How long a shutdown may take while a part of a run never settles: shorter than its deadlines. */
const promptlyMs = 5_000

const echo = hostTool({ name: 'echo', input: z.object({ text: z.string() }) }, ({ text }) => Promise.resolve(`echo: ${text}`))

/** Started and never settles, until its call is stopped. */
const started = vi.fn()
const never = hostTool({ name: 'never', input: z.object({}) }, () => {
	started()
	return new Promise<never>(() => undefined)
})

/** An engine on the host backend with a gateway that has `tools`, closed when the test ends. */
async function openEngine({
	home,
	tools = [echo, never],
	fetch,
	connectorSettings,
	signIns,
	sandboxes,
}: {
	readonly home?: string
	/** Changes the sandboxes the host backend makes, such as to make one of their parts hang. */
	readonly sandboxes?: (sandbox: Sandbox) => Sandbox
	readonly tools?: readonly HostTool[]
	readonly fetch?: typeof globalThis.fetch
	readonly connectorSettings?: ConnectorSettingsCheck
	readonly signIns?: SignIns
} = {}) {
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
		...(fetch === undefined ? {} : { fetch }),
	})
	const host = hostBackend(path.join(directory, 'sandboxes'))
	const backend: SandboxBackend =
		sandboxes === undefined ? host : { ...host, create: async (...args) => sandboxes(await host.create(...args)) }
	const apps = await openAppStore(path.join(directory, 'apps'), abortSignal)
	const log = vi.fn<(message: string) => void>()
	const engine = await Engine.open(
		{
			backend,
			store: openRunStore(path.join(directory, 'runs')),
			apps,
			gateway,
			layout: hostSandboxLayout,
			log,
			...(connectorSettings === undefined ? {} : { connectorSettings }),
			...(signIns === undefined ? {} : { signIns }),
		},
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

/** A runtime that takes its grant and calls the gateway with `call(id, call, token, endpoint?)` (the run's endpoint by default), which resolves to the answer's value. */
function callingScript(body: string): string {
	return runtimeScript(`
const grant = await mailbox.takeGrant(signal)
const call = async (id, gatewayCall, token, endpoint = grant.endpoint) => {
	mailbox.send({ type: 'call', id, endpoint, token, call: gatewayCall })
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

	test('fetches packages from the registries the app restores from, staging each body for the sandbox, and no other', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"name":"left-pad"}')))
		const { engine, apps } = await openEngine({ fetch: sent })
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
const npm = await call('call-1', { type: 'package', request: { registry: 'npm', path: '/left-pad' } }, grant.packages.tokens[0], grant.packages.endpoint)
const nuget = await call('call-2', { type: 'package', request: { registry: 'nuget', path: '/v3/index.json' } }, npm.next, grant.packages.endpoint)
const { readFile } = await import('node:fs/promises')
const staged = await readFile(mailbox.staged(npm.outcome.result.body), 'utf8')
event('done', 'called', { npm: npm.outcome, nuget: nuget.outcome, staged })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ registries: ['npm'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		const [done] = await engine.events(run.id)
		expect(done).toMatchObject({
			npm: { ok: true, result: { status: 200, body: 'call-1.body', size: '{"name":"left-pad"}'.length } },
			nuget: { ok: false },
			staged: '{"name":"left-pad"}',
		})
		expect(JSON.stringify(done)).toContain("doesn't restore from nuget")
		expect(sent).toHaveBeenCalledOnce()
	})

	test('shuts down promptly while staging a fetched body in the sandbox never settles', async () => {
		// Arrange
		const staging = vi.fn()
		const hangsOnStaging = (sandbox: Sandbox): Sandbox => ({
			id: sandbox.id,
			exec: (command, options) => sandbox.exec(command, options),
			startInBackground: (command, options) => sandbox.startInBackground(command, options),
			readFile: (file, readAbortSignal) => sandbox.readFile(file, readAbortSignal),
			writeFile: (file, content, writeAbortSignal) => {
				if (!file.endsWith('.body')) return sandbox.writeFile(file, content, writeAbortSignal)
				staging()
				return new Promise<never>(() => undefined)
			},
			pause: (pauseAbortSignal) => sandbox.pause(pauseAbortSignal),
			destroy: (destroyAbortSignal) => sandbox.destroy(destroyAbortSignal),
		})
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response('tarball')))
		const { engine, apps } = await openEngine({ fetch: sent, sandboxes: hangsOnStaging })
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
await call('call-1', { type: 'package', request: { registry: 'npm', path: '/left-pad/-/left-pad-1.3.0.tgz' } }, grant.packages.tokens[0], grant.packages.endpoint)
`),
			},
			{ registries: ['npm'] },
		)
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await vi.waitFor(() => {
			expect(staging).toHaveBeenCalled()
		})

		// Act
		const startedAt = Date.now()
		await engine.close(deadlines())

		// Assert
		expect(Date.now() - startedAt).toBeLessThan(promptlyMs)
		expect(engine.get(run.id).status).not.toBe('running')
	})

	test('answers a call that needs a sign-in with the connector, signs in for the login the runtime asks for, and runs the tool again', async () => {
		// Arrange
		const cloud = { signedIn: false }
		const session = hostTool({ name: 'cloudSession', input: z.object({}) }, () => {
			if (!cloud.signedIn) return Promise.reject(new SignInNeededError('cloud'))
			return Promise.resolve('live')
		})
		const login = vi.fn(() => {
			cloud.signedIn = true
			return Promise.resolve()
		})
		const signIns = openSignIns({ connectors: [{ name: 'cloud', signIn: login }] })
		const { engine, apps } = await openEngine({ tools: [session], signIns })
		await deployTestApp(
			apps,
			{
				calls: callingScript(`
const first = await call('call-1', { type: 'tool', tool: 'cloudSession', input: {} }, grant.tokens[0])
mailbox.send({ type: 'request', request: { kind: 'login', id: 'login-1', connector: first.outcome.signInTo } })
await mailbox.answer('login-1', signal)
const second = await call('call-2', { type: 'tool', tool: 'cloudSession', input: {} }, first.next)
event('done', 'called', { first: first.outcome, second: second.outcome })
mailbox.send({ type: 'succeeded' })
`),
			},
			{ tools: ['cloudSession'] },
		)

		// Act
		const run = await engine.startRun({ ...userRun('calls'), abortSignal })
		await untilStatus(engine, run.id, 'succeeded')

		// Assert
		const [done] = await engine.events(run.id)
		expect(done).toMatchObject({ first: { ok: false, signInTo: 'cloud' }, second: { ok: true, result: 'live' } })
		expect(login).toHaveBeenCalledOnce()
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

	test('shuts down while a host tool never settles, and answers the call as interrupted after a resume, with nothing staged for it', async () => {
		// Arrange
		const first = await openEngine()
		await deployTestApp(
			first.apps,
			{
				calls: callingScript(`
const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
// As if the engine had staged a body for the call, and been stopped before it answered.
const staged = process.env.MESH_FLOW_MAILBOX + '/packages/call-1.body.tmp'
mkdirSync(process.env.MESH_FLOW_MAILBOX + '/packages', { recursive: true })
writeFileSync(staged, 'cut short')
const answer = await call('call-1', { type: 'tool', tool: 'never', input: {} }, grant.tokens[0])
const next = await call('call-2', { type: 'tool', tool: 'echo', input: { text: 'after' } }, answer.next)
event('done', 'called', { first: answer.outcome, second: next.outcome, staged: existsSync(staged) })
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
		expect(done).toMatchObject({ first: { ok: false }, second: { ok: true, result: 'echo: after' }, staged: false })
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

	test('lists the settings an app still needs: unserved models and host tools no connector brings', async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		const deployed = await deployTestApp(
			apps,
			{ calls: runtimeScript(`mailbox.send({ type: 'succeeded' })`) },
			{ tools: ['echo', 'githubComment'], models: [appModel] },
		)

		// Act
		const missing = await engine.missingSettings(deployed.manifest.description, abortSignal)

		// Assert
		expect(missing).toHaveLength(2)
		expect(missing[0]).toContain('No model providers are set up')
		expect(missing[1]).toContain('host tools githubComment')
	})

	test("lists what the connectors behind the app's registries still need, and a registry whose connector isn't loaded", async () => {
		// Arrange
		const registry = { connector: 'cloud', name: 'cloud packages', host: 'packages.cloud.example', paths: ['/npm/packages/'], settings: {} }
		const connectorSettings = vi.fn<ConnectorSettingsCheck>(() =>
			Promise.resolve(['Set the cloud start URL: `mesh-flow credential set cloud/start-url`.']),
		)
		const { engine, apps } = await openEngine({ connectorSettings })
		const deployed = await deployTestApp(
			apps,
			{ calls: runtimeScript(`mailbox.send({ type: 'succeeded' })`) },
			{ tools: ['echo'], registries: ['npm', registry] },
		)

		// Act
		const missing = await engine.missingSettings(deployed.manifest.description, abortSignal)

		// Assert
		expect(missing).toEqual([expect.stringContaining('cloud packages needs connector cloud'), expect.stringContaining('cloud start URL')])
		expect(connectorSettings).toHaveBeenCalledWith({ tools: ['echo'], registries: ['npm', registry] }, abortSignal)
	})

	test('refuses a run before its sandbox when no loaded connector brings a host tool the app lists', async () => {
		// Arrange
		const { engine, apps } = await openEngine()
		await deployTestApp(apps, { calls: runtimeScript(`mailbox.send({ type: 'succeeded' })`) }, { tools: ['echo', 'githubComment'] })

		// Act
		const refused = engine.startRun({ ...userRun('calls'), abortSignal })

		// Assert
		await expect(refused).rejects.toMatchObject({ code: 'unavailable' })
		await expect(refused).rejects.toThrow('host tools githubComment. Add the connector with `mesh-flow connector add')
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
