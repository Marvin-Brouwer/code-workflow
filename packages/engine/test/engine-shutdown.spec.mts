import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Sandbox, SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { Engine } from '../src/engine/engine.mts'
import { pollScript } from '../src/mailbox/poll-script.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { deferred } from './support/deferred.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runtimeScript, workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal
const never = () => new Promise<never>(() => undefined)

/** A backend that answers what the engine needs to start a run, with the parts given here. */
function stubBackend(parts: { create?: SandboxBackend['create']; poll?: () => Promise<never>; pause?: Sandbox['pause'] }) {
	const sandbox: Sandbox = {
		id: 'mesh-flow-000000000001',
		async exec(command) {
			if (command[2] !== pollScript) return { exitCode: 0, stdout: '', stderr: '' }
			if (parts.poll) return parts.poll()
			await delay(50)
			return { exitCode: 0, stdout: '', stderr: '' }
		},
		startInBackground: () => Promise.resolve(),
		readFile: () => Promise.resolve(''),
		writeFile: () => Promise.resolve(),
		pause: parts.pause ?? never,
		destroy: () => Promise.resolve(),
	}
	const close = vi.fn(() => Promise.resolve())
	const backend: SandboxBackend = {
		name: 'gvisor',
		create: parts.create ?? (() => Promise.resolve(sandbox)),
		resume: never,
		list: () => Promise.resolve([]),
		remove: () => Promise.resolve(),
		close,
	}
	return { backend, close }
}

/** Deadlines short enough that a hang shows as a slow test. */
const shortDeadlines = () => ({ pause: AbortSignal.timeout(200), backend: AbortSignal.timeout(400) })

/** Starts a run on `backend` in a new engine, closed when the test ends if it isn't already. */
async function startRun(backend: SandboxBackend) {
	const home = await temporaryDirectory()
	const engine = await Engine.open({ backend, store: openRunStore(path.join(home, 'runs')) }, signal)
	onTestFinished(() => engine.close(shortDeadlines()))
	const directory = await workflowRepository({ hello: runtimeScript('') })
	const { id } = await engine.startRun({ directory, workflow: 'hello', signal })
	return { engine, id }
}

describe('Engine.close', () => {
	test('finishes within its deadlines when creating a sandbox never settles', async () => {
		// Arrange
		const { backend, close } = stubBackend({ create: never })
		const { engine, id } = await startRun(backend)
		const started = Date.now()

		// Act
		await engine.close(shortDeadlines())

		// Assert
		expect(Date.now() - started).toBeLessThan(2_000)
		expect(engine.get(id)).toMatchObject({ status: 'restartable' })
		expect(close).toHaveBeenCalledOnce()
	})

	test('does not let a sandbox that arrives after the shutdown gave up on it change the run', async () => {
		// Arrange
		const created = deferred<Sandbox>()
		const { backend } = stubBackend({ create: () => created.promise })
		const { engine, id } = await startRun(backend)
		await engine.close(shortDeadlines())

		// Act
		created.resolve(await stubBackend({}).backend.create({ image: 'host', cpus: 1, memoryMb: 256, egress: { allow: [] } }, signal))
		await delay(100)

		// Assert
		expect(engine.get(id)).toMatchObject({ status: 'restartable' })
		expect(engine.get(id).sandbox).toBeUndefined()
	})

	test('finishes within its deadlines when the poll and the pause never settle', async () => {
		// Arrange
		const { backend, close } = stubBackend({ poll: never, pause: never })
		const { engine, id } = await startRun(backend)
		await vi.waitFor(() => {
			expect(engine.get(id).status).toBe('running')
		})
		const started = Date.now()

		// Act
		await engine.close(shortDeadlines())

		// Assert
		expect(Date.now() - started).toBeLessThan(2_000)
		expect(engine.get(id).status).toBe('restartable')
		expect(engine.get(id).error).toContain('Pausing on shutdown failed')
		expect(close).toHaveBeenCalledOnce()
	})

	test('refuses new runs once it has started', async () => {
		// Arrange
		const { engine } = await startRun(stubBackend({}).backend)
		await engine.close(shortDeadlines())

		// Act
		const starting = engine.startRun({ directory: '.', workflow: 'hello', signal })

		// Assert
		await expect(starting).rejects.toThrow('shutting down')
	})
})
