import path from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { ControlClient } from '../src/control/control-client.mts'
import { controlSocketPath } from '../src/control/control-socket.mts'
import { serveEngine } from '../src/serve/serve-engine.mts'
import { hostBackend, hostSandboxLayout, isAlive, pidsOf } from './support/host-backend.mts'
import { exitOf, startEngineProcess } from './support/engine-process.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runtimeScript, workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(5_000), close: AbortSignal.timeout(10_000) })

const ask = runtimeScript(`
mailbox.send({ type: 'request', request: { kind: 'input', id: 'story', question: 'Which story?', fields: {} } })
await mailbox.answer('story', signal)
mailbox.send({ type: 'succeeded' })
`)

/** Serves an engine on the host backend in this process, closed when the test ends. */
async function serveHere(home: string) {
	const served = await serveEngine({ home, backend: hostBackend(path.join(home, 'sandboxes')), layout: hostSandboxLayout, signal })
	onTestFinished(() => served.close(deadlines()))
	return served
}

/** Starts a run in an engine process and waits until it asks for input. Returns the runtime's pid. */
async function startWaitingRun(home: string) {
	const directory = await workflowRepository({ ask })
	const client = new ControlClient(controlSocketPath(home))
	const { id } = await client.startRun(directory, 'ask', signal)
	const record = await vi.waitFor(
		async () => {
			const current = await client.get(id, signal)
			if (current.pending.length === 0) throw new Error(`Run is ${current.status}`)
			return current
		},
		{ timeout: 20_000, interval: 100 },
	)
	const sandbox = record.sandbox?.id ?? ''
	const [runtime = 0] = await pidsOf(path.join(home, 'sandboxes'), sandbox)
	return { id, sandbox, runtime }
}

describe.skipIf(process.platform !== 'linux')('the engine as a process', () => {
	test('cleans up on the next start after it was killed with SIGKILL', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const engine = await startEngineProcess(home)
		const run = await startWaitingRun(home)
		engine.kill('SIGKILL')
		await exitOf(engine)
		const leftBehind = isAlive(run.runtime)

		// Act
		const served = await serveHere(home)

		// Assert
		expect(leftBehind).toBe(true)
		expect(served.engine.list()).toEqual([expect.objectContaining({ id: run.id, status: 'restartable', pending: [] })])
		await vi.waitFor(() => {
			expect(isAlive(run.runtime)).toBe(false)
		})
	})

	test('pauses the running sandboxes on SIGINT, and resumes them after a restart', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const engine = await startEngineProcess(home)
		const run = await startWaitingRun(home)

		// Act
		engine.kill('SIGINT')
		const exitCode = await exitOf(engine)
		const served = await serveHere(home)
		const paused = served.engine.get(run.id)
		await served.engine.resume(run.id, signal)
		await served.engine.answer(run.id, 'story', 'resumed', signal)

		// Assert
		expect(exitCode).toBe(0)
		expect(paused.status).toBe('paused')
		await vi.waitFor(() => {
			expect(served.engine.get(run.id).status).toBe('succeeded')
		}, 20_000)
	})

	test('refuses to start a second engine on the same home', async () => {
		// Arrange
		const home = await temporaryDirectory()
		await startEngineProcess(home)

		// Act
		const second = serveEngine({ home, backend: hostBackend(path.join(home, 'sandboxes')), signal })

		// Assert
		await expect(second).rejects.toThrow('already running')
	})
})
