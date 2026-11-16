import path from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { openAppStore } from '../src/apps/app-store.mts'
import type { LoginContext } from '../src/connectors/load-connectors.mts'
import { Engine } from '../src/engine/engine.mts'
import { openSignIns } from '../src/engine/sign-ins.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { deployTestApp, runtimeScript, userRun } from './support/test-app.mts'

const signal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(5_000), backend: AbortSignal.timeout(10_000) })
/** How long a shutdown may take while a sign-in never settles. */
const promptlyMs = 5_000

const prompt = { url: 'https://device.example/?user_code=ABCD', code: 'ABCD', expiresAt: new Date('2026-11-16T09:10:00Z') }

/** A sign-in to `cloud` that shows {@link prompt} and waits for `approve`, or for its signal to abort. */
function cloudLogin() {
	const contexts: LoginContext[] = []
	const approvals: Array<() => void> = []
	const login = vi.fn((context: LoginContext) => {
		contexts.push(context)
		context.show(prompt)
		const { promise, resolve } = Promise.withResolvers<undefined>()
		approvals.push(() => {
			resolve(undefined)
		})
		// Ignores its signal, like a sign-in stuck on the network: a shutdown mustn't wait for it.
		return promise
	})
	return {
		login,
		contexts,
		approve: () => {
			approvals.at(-1)?.()
		},
	}
}

/** An engine on the host backend whose connectors are `cloud`, signing in with `login`, closed when the test ends. */
async function openEngine(login: (context: LoginContext) => Promise<void>, home?: string) {
	const directory = home ?? (await temporaryDirectory())
	const apps = await openAppStore(path.join(directory, 'apps'), signal)
	const engine = await Engine.open(
		{
			backend: hostBackend(path.join(directory, 'sandboxes')),
			store: openRunStore(path.join(directory, 'runs')),
			apps,
			layout: hostSandboxLayout,
			signIns: openSignIns({ connectors: [{ name: 'cloud', login }, { name: 'tracker' }] }),
		},
		signal,
	)
	onTestFinished(() => engine.close(deadlines()))
	return { engine, apps, home: directory }
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

/** Until `login` was called: the engine starts the sign-in just after it saved the request. */
async function untilCalled(login: ReturnType<typeof cloudLogin>['login']): Promise<void> {
	await vi.waitFor(() => {
		expect(login).toHaveBeenCalled()
	})
}

async function untilPending(engine: Engine, id: string, requestId: string): Promise<void> {
	await vi.waitFor(
		() => {
			if (!engine.get(id).pending.some((request) => request.id === requestId)) throw new Error(`Not waiting for ${requestId} yet`)
		},
		{ timeout: 20_000, interval: 50 },
	)
}

/** A runtime that asks for a sign-in to `connector`, as a host tool's stub does when the tool needs one, and goes on once it's answered. */
function signingInScript(connector: string): string {
	return runtimeScript(`
mailbox.send({ type: 'request', request: { kind: 'login', id: 'login-1', connector: ${JSON.stringify(connector)} } })
await mailbox.answer('login-1', signal)
event('signed-in', 'signed-in')
mailbox.send({ type: 'succeeded' })
`)
}

describe.skipIf(process.platform !== 'linux')('runs that wait for a sign-in', () => {
	test('waits for the sign-in, shows where to sign in, and goes on once the user approved', async () => {
		// Arrange
		const { login, approve } = cloudLogin()
		const { engine, apps } = await openEngine(login)
		await deployTestApp(apps, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal: signal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(login)

		// Act
		const shown = engine.signIns()
		approve()
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(shown.map((signIn) => [signIn.connector, signIn.prompt?.code])).toEqual([['cloud', prompt.code]])
		expect(await engine.events(id)).toEqual([expect.objectContaining({ type: 'signed-in' })])
		expect(engine.signIns()).toEqual([])
	})

	test('lets `mesh-flow login` join the sign-in the run waits for', async () => {
		// Arrange
		const { login, approve } = cloudLogin()
		const { engine, apps } = await openEngine(login)
		await deployTestApp(apps, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal: signal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(login)

		// Act
		const fromCli = engine.signIn('cloud', signal)
		approve()
		await fromCli
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(login).toHaveBeenCalledTimes(1)
	})

	test('pauses a run that waits for a sign-in on close, and signs in again once it is resumed', async () => {
		// Arrange
		const first = cloudLogin()
		const opened = await openEngine(first.login)
		await deployTestApp(opened.apps, { cloud: signingInScript('cloud') })
		const { id } = await opened.engine.startRun({ ...userRun('cloud'), abortSignal: signal })
		await untilPending(opened.engine, id, 'login-1')
		await untilCalled(first.login)
		await opened.engine.close(deadlines())
		const second = cloudLogin()
		const reopened = await openEngine(second.login, opened.home)

		// Act
		const resumed = await reopened.engine.resume(id, signal)
		await untilCalled(second.login)
		second.approve()
		await untilStatus(reopened.engine, id, 'succeeded')

		// Assert
		expect(first.contexts[0]?.abortSignal.aborted).toBe(true)
		expect(resumed.pending).toEqual([{ kind: 'login', id: 'login-1', connector: 'cloud' }])
	})

	test('shuts down promptly while a run waits for a sign-in that never settles', async () => {
		// Arrange
		const { login, contexts } = cloudLogin()
		const { engine, apps } = await openEngine(login)
		await deployTestApp(apps, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal: signal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(login)

		// Act
		const startedAt = Date.now()
		await engine.close(deadlines())

		// Assert
		expect(Date.now() - startedAt).toBeLessThan(promptlyMs)
		expect(contexts[0]?.abortSignal.aborted).toBe(true)
		expect(engine.get(id).status).toBe('paused')
	})

	test('fails a run that asks for a sign-in no connector of the engine does', async () => {
		// Arrange
		const { login } = cloudLogin()
		const { engine, apps } = await openEngine(login)
		await deployTestApp(apps, { tracker: signingInScript('tracker') })

		// Act
		const { id } = await engine.startRun({ ...userRun('tracker'), abortSignal: signal })
		const failed = await untilStatus(engine, id, 'failed')

		// Assert
		expect(failed.error).toContain('no connector tracker that signs in')
		expect(login).not.toHaveBeenCalled()
	})
})
