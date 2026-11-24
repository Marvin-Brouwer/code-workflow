import path from 'node:path'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { openDeployment } from '../src/app/deployment.mts'
import type { SignInContext } from '../src/connectors/load-connectors.mts'
import { Engine } from '../src/engine/engine.mts'
import { openSignIns } from '../src/engine/sign-ins.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { approvableSignIn, prompt } from './support/approvable-sign-in.mts'
import { hostBackend, hostSandboxLayout } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { deployTestApp, runtimeScript, userRun } from './support/test-app.mts'

const abortSignal = new AbortController().signal
const deadlines = () => ({ pause: duration.of('5s').toAbortSignal(), backend: duration.of('10s').toAbortSignal() })
/** How long a shutdown may take while a sign-in never settles. */
const promptly = duration.of('5s')

/** An engine on the host backend whose connectors are `cloud`, signing in with `signIn`, closed when the test ends. */
async function openEngine(signIn: (context: SignInContext) => Promise<void>, home?: string) {
	const directory = home ?? (await temporaryDirectory())
	const app = await openDeployment(path.join(directory, 'app'), abortSignal)
	const engine = await Engine.open(
		{
			backend: hostBackend(path.join(directory, 'sandboxes')),
			store: openRunStore(path.join(directory, 'runs')),
			app,
			layout: hostSandboxLayout,
			signIns: openSignIns({ connectors: [{ name: 'cloud', signIn }, { name: 'tracker' }], idle: shortIdle }),
		},
		abortSignal,
	)
	onTestFinished(() => engine.close(deadlines()))
	return { engine, app, home: directory }
}

/** How long a sign-in nobody waits for goes on in these tests. */
const shortIdle = duration.of('50ms')

/** How long the runtime that cancels its `login` waits before it does, so the sign-in has started. */
const cancelAfter = duration.of('1s')

/** How long and how often the tests look for a run to get where they wait for it. */
const untilOptions = { timeout: duration.of('20s').to('ms'), interval: 50 }

/** Until run `id` has `status`, which it then has. */
async function untilStatus(engine: Engine, id: string, status: RunStatus): Promise<RunRecord> {
	return vi.waitFor(() => {
		const record = engine.get(id)
		if (record.status !== status) throw new Error(`Run is ${record.status}${record.error ? `: ${record.error}` : ''}`)
		return record
	}, untilOptions)
}

/** Until `signIn` was called: the engine starts the sign-in just after it saved the request. */
async function untilCalled(signIn: ReturnType<typeof approvableSignIn>['signIn']): Promise<void> {
	await vi.waitFor(() => {
		expect(signIn).toHaveBeenCalled()
	})
}

/** Until run `id` saved that it waits for request `requestId`. */
async function untilPending(engine: Engine, id: string, requestId: string): Promise<void> {
	await vi.waitFor(() => {
		if (!engine.get(id).pending.some((request) => request.id === requestId)) throw new Error(`Not waiting for ${requestId} yet`)
	}, untilOptions)
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
		const { signIn, approve } = approvableSignIn({ honoursAbort: false })
		const { engine, app } = await openEngine(signIn)
		await deployTestApp(app, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(signIn)

		// Act
		const shown = engine.signIns()
		approve()
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(shown.map((state) => [state.connector, state.prompt?.code])).toEqual([['cloud', prompt.code]])
		expect(await engine.events(id)).toEqual([expect.objectContaining({ type: 'signed-in' })])
		expect(engine.signIns()).toEqual([])
	})

	test('lets `mesh-flow login` join the sign-in the run waits for', async () => {
		// Arrange
		const { signIn, approve } = approvableSignIn({ honoursAbort: false })
		const { engine, app } = await openEngine(signIn)
		await deployTestApp(app, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(signIn)

		// Act
		const fromCli = engine.waitForSignIn('cloud', abortSignal)
		approve()
		await fromCli
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(signIn).toHaveBeenCalledTimes(1)
	})

	test('pauses a run that waits for a sign-in on close, and answers it once resumed, without a new sign-in', async () => {
		// Arrange
		const first = approvableSignIn({ honoursAbort: false })
		const opened = await openEngine(first.signIn)
		await deployTestApp(opened.app, { cloud: signingInScript('cloud') })
		const { id } = await opened.engine.startRun({ ...userRun('cloud'), abortSignal })
		await untilPending(opened.engine, id, 'login-1')
		await untilCalled(first.signIn)
		await opened.engine.close(deadlines())
		const second = approvableSignIn({ honoursAbort: false })
		const reopened = await openEngine(second.signIn, opened.home)

		// Act
		const resumed = await reopened.engine.resume(id, abortSignal)
		await untilStatus(reopened.engine, id, 'succeeded')

		// Assert
		expect(first.contexts[0]?.abortSignal.aborted).toBe(true)
		expect(resumed.pending).toEqual([{ kind: 'login', id: 'login-1', connector: 'cloud' }])
		expect(second.signIn).not.toHaveBeenCalled()
	})

	test('shuts down promptly while a run waits for a sign-in that never settles', async () => {
		// Arrange
		const { signIn, contexts } = approvableSignIn({ honoursAbort: false })
		const { engine, app } = await openEngine(signIn)
		await deployTestApp(app, { cloud: signingInScript('cloud') })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal })
		await untilPending(engine, id, 'login-1')
		await untilCalled(signIn)

		// Act
		const startedAt = Date.now()
		await engine.close(deadlines())

		// Assert
		expect(Date.now() - startedAt).toBeLessThan(promptly.to('ms'))
		expect(contexts[0]?.abortSignal.aborted).toBe(true)
		expect(engine.get(id).status).toBe('paused')
	})

	test('stops the sign-in a run cancels a while after, while the run goes on', async () => {
		// Arrange
		const { signIn, contexts } = approvableSignIn({ honoursAbort: false })
		const { engine, app } = await openEngine(signIn)
		const cancelling = runtimeScript(`
mailbox.send({ type: 'request', request: { kind: 'login', id: 'login-1', connector: 'cloud' } })
await new Promise((resolve) => setTimeout(resolve, ${String(cancelAfter.to('ms'))}))
mailbox.send({ type: 'cancel', id: 'login-1' })
await mailbox.answer('never', signal)
`)
		await deployTestApp(app, { cloud: cancelling })
		const { id } = await engine.startRun({ ...userRun('cloud'), abortSignal })
		await untilCalled(signIn)

		// Act: the runtime cancels its `login` after a while
		await vi.waitFor(() => {
			expect(contexts[0]?.abortSignal.aborted).toBe(true)
		}, untilOptions)

		// Assert
		expect(engine.get(id)).toMatchObject({ status: 'running', pending: [] })
		expect(engine.signIns()).toEqual([])
	})

	test('fails a run that asks for a sign-in no connector of the engine does', async () => {
		// Arrange
		const { signIn } = approvableSignIn({ honoursAbort: false })
		const { engine, app } = await openEngine(signIn)
		await deployTestApp(app, { tracker: signingInScript('tracker') })

		// Act
		const { id } = await engine.startRun({ ...userRun('tracker'), abortSignal })
		const failed = await untilStatus(engine, id, 'failed')

		// Assert
		expect(failed.error).toContain('no connector tracker that signs in')
		expect(signIn).not.toHaveBeenCalled()
	})
})
