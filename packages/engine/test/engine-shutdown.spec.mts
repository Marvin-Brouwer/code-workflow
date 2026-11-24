import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { duration } from '@mesh-flow/duration'
import type { Sandbox, SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { openAppStore } from '../src/app/app-store.mts'
import { Engine } from '../src/engine/engine.mts'
import { pollScript } from '../src/mailbox/poll-script.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { deferred } from './support/deferred.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { deployTestApp, runtimeScript, userRun } from './support/test-app.mts'

const signal = new AbortController().signal
const never = () => new Promise<never>(() => undefined)
const specification = { image: 'host', cpus: 1, memoryMb: 256 }
const sandboxId = 'mesh-flow-000000000001'
const pausesAtOnce: Sandbox['pause'] = () => Promise.resolve({ backend: 'gvisor', id: sandboxId, specification })

/** A backend that answers what the engine needs to start a run, with the parts given here. */
function stubBackend(parts: {
	create?: SandboxBackend['create']
	unpack?: () => Promise<never>
	poll?: () => Promise<never>
	pause?: Sandbox['pause']
}) {
	const sandbox: Sandbox = {
		id: sandboxId,
		async exec(command) {
			if (parts.unpack && command[2]?.includes('tar -xzf')) return parts.unpack()
			if (command[2] !== pollScript) return { exitCode: 0, stdout: '', stderr: '' }
			if (parts.poll) return parts.poll()
			await delay(duration.of('50ms').to('ms'))
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

/**
 * The backend deadline of {@link shortDeadlines}. A Windows runner that runs every package's tests
 * at once took longer than a second to get through the pauses and the flush, which made `close`
 * reject on a deadline that had passed before it closed the backend.
 */
const shortBackend = duration.of('1500ms')

/** How long a close on {@link shortDeadlines} may take: its backend deadline, and a second to see that it passed. */
const promptly = duration.of('2500ms')

/**
 * Deadlines short enough that a hang shows as a slow test. Both start together, so a pause that
 * never settles leaves flushing and closing the backend only the gap between them: that gap has
 * to hold up on a busy CI runner.
 */
const shortDeadlines = () => ({ pause: duration.of('200ms').toAbortSignal(), backend: shortBackend.toAbortSignal() })

/** A backend deadline a busy runner can't run out of. */
const ampleBackend = duration.of('20s')

/** A short pause deadline, so work that never settles doesn't hold the close up, and an ample backend deadline. */
const shortPauseDeadlines = () => ({ pause: duration.of('200ms').toAbortSignal(), backend: ampleBackend.toAbortSignal() })

/** Deadlines for a test about what a shutdown leads to, not how long it takes: a busy runner can't run out of them. */
const ampleDeadlines = () => ({ pause: duration.of('10s').toAbortSignal(), backend: ampleBackend.toAbortSignal() })

/** Starts a run on `backend` in a new engine, closed when the test ends if it isn't already. */
async function startRun(backend: SandboxBackend) {
	const home = await temporaryDirectory()
	const app = await openAppStore(path.join(home, 'app'), signal)
	await deployTestApp(app, { hello: runtimeScript('') })
	const engine = await Engine.open({ backend, store: openRunStore(path.join(home, 'runs')), app }, signal)
	onTestFinished(() => engine.close(shortDeadlines()))
	const { id } = await engine.startRun({ ...userRun('hello'), abortSignal: signal })
	return { engine, id }
}

describe('Engine.close', () => {
	test('finishes within its deadlines when unpacking the app in the sandbox never settles', async () => {
		// Arrange
		const unpacking = deferred<undefined>()
		const { backend, close } = stubBackend({
			unpack: () => {
				unpacking.resolve(undefined)
				return never()
			},
		})
		const { engine, id } = await startRun(backend)
		await unpacking.promise
		const started = Date.now()

		// Act
		await engine.close(shortDeadlines())

		// Assert
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
		expect(engine.get(id)).toMatchObject({ status: 'restartable' })
		expect(close).toHaveBeenCalledOnce()
	})

	test('finishes within its deadlines when creating a sandbox never settles', async () => {
		// Arrange
		const { backend, close } = stubBackend({ create: never })
		const { engine, id } = await startRun(backend)
		const started = Date.now()

		// Act
		await engine.close(shortDeadlines())

		// Assert
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
		expect(engine.get(id)).toMatchObject({ status: 'restartable' })
		expect(close).toHaveBeenCalledOnce()
	})

	test('does not let a sandbox that arrives after the shutdown gave up on it change the run', async () => {
		// Arrange
		const created = deferred<Sandbox>()
		const { backend } = stubBackend({ create: () => created.promise })
		const { engine, id } = await startRun(backend)
		await engine.close(shortPauseDeadlines())

		// Act
		created.resolve(await stubBackend({}).backend.create(specification, signal))
		await delay(duration.of('100ms').to('ms'))

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
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
		expect(engine.get(id).status).toBe('restartable')
		expect(engine.get(id).error).toContain('Pausing on shutdown failed')
		expect(close).toHaveBeenCalledOnce()
	})

	test('refuses new runs once it has started', async () => {
		// Arrange: a pause that settles, so the shutdown doesn't wait out any deadline, and a busy
		// runner, which flushed the records in over a second on Windows, doesn't run out of one.
		const { engine } = await startRun(stubBackend({ pause: pausesAtOnce }).backend)
		await engine.close(ampleDeadlines())

		// Act
		const starting = engine.startRun({ ...userRun('hello'), abortSignal: signal })

		// Assert
		await expect(starting).rejects.toThrow('shutting down')
	})
})
