import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test } from 'vitest'
import { BackendMismatchError } from '../../src/backend-mismatch-error.mts'
import { gvisorBackend } from '../../src/gvisor/gvisor.backend.mts'
import { Layout } from '../../src/gvisor/layout.mts'
import type { PausedSandbox } from '../../src/paused-sandbox.mts'
import type { SandboxBackend } from '../../src/sandbox-backend.mts'
import type { SandboxSpecification } from '../../src/sandbox-specification.mts'
import { fakeContainerFile, fakeRunsc, type FakeRunscOptions } from '../support/fake-runsc.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

const specification: SandboxSpecification = { image: 'node:26-slim', cpus: 1, memoryMb: 512 }

function timeout(): AbortSignal {
	return duration.of('5s').toAbortSignal()
}

interface FakeBackend {
	readonly backend: SandboxBackend
	readonly directory: string
	/** Another backend on the same directory, as after a restart. Closed when the test ends. */
	readonly reopen: () => SandboxBackend
}

async function backendOnFakeRunsc(options: FakeRunscOptions = {}): Promise<FakeBackend> {
	const directory = await temporaryDirectory()
	const runsc = await fakeRunsc(directory, specification.image, options)
	const open = () => {
		const backend = gvisorBackend({ directory, runsc })
		onTestFinished(() => backend.close(timeout()).catch(() => undefined))
		return backend
	}
	return { backend: open(), directory, reopen: open }
}

async function sandboxDirectories(directory: string): Promise<string[]> {
	const { sandboxes } = new Layout(directory)
	return existsSync(sandboxes) ? readdir(sandboxes) : []
}

describe('gVisor backend, on a fake runsc', () => {
	test('keeps the id across a pause and resume, and list follows the state', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())

		// Act
		const paused = await sandbox.pause(timeout())
		const listedPaused = await backend.list(timeout())
		const resumed = await backend.resume(paused, timeout())
		const listedRunning = await backend.list(timeout())

		// Assert
		expect(paused).toMatchObject({ backend: 'gvisor', id: sandbox.id, specification })
		expect(listedPaused).toEqual([{ id: sandbox.id, state: 'paused' }])
		expect(resumed.id).toBe(sandbox.id)
		expect(listedRunning).toEqual([{ id: sandbox.id, state: 'running' }])
	})

	test('runs commands and returns a non-zero exit code as a result', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())

		// Act
		const result = await sandbox.exec(['sh', '-c', 'echo out; echo err >&2; exit 3'], { signal: timeout() })

		// Assert
		expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
	})

	test('returns when a command ends, even if it leaves a process behind that holds stdout', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())

		// Act
		const result = await sandbox.exec(['sh', '-c', 'sleep 5 & echo started'], { signal: timeout() })

		// Assert
		expect(result).toEqual({ exitCode: 0, stdout: 'started\n', stderr: '' })
	})

	test('refuses to resume a pause made by another backend', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const paused: PausedSandbox = { backend: 'microsandbox', id: 'mesh-flow-0123456789ab', specification: specification, snapshot: 'x' }

		// Act
		const resuming = backend.resume(paused, timeout())

		// Assert
		await expect(resuming).rejects.toThrow(BackendMismatchError)
	})

	test('refuses to resume a sandbox that is already running again', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const paused = await (await backend.create(specification, timeout())).pause(timeout())
		await backend.resume(paused, timeout())

		// Act
		const again = backend.resume(paused, timeout())

		// Assert
		await expect(again).rejects.toThrow('already running')
	})

	test('lists a stopped container with a finished checkpoint as paused', async () => {
		// Arrange
		const { backend, directory } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())
		await sandbox.pause(timeout())
		// As when the pause couldn't delete its container.
		await writeFile(fakeContainerFile(directory, sandbox.id), 'stopped\n')

		// Act
		const listed = await backend.list(timeout())

		// Assert
		expect(listed).toEqual([{ id: sandbox.id, state: 'paused' }])
	})

	test('settles an exec that never ends as soon as its signal aborts', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())
		const controller = new AbortController()
		const running = sandbox.exec(['sleep', '3600'], { signal: controller.signal })

		// Act
		controller.abort(new Error('shutting down'))

		// Assert
		await expect(running).rejects.toThrow()
	})

	test('closes while an exec never ends, and leaves nothing behind', async () => {
		// Arrange
		const { backend, directory, reopen } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())
		const running = sandbox.exec(['sleep', '3600'], { signal: new AbortController().signal })
		running.catch(() => undefined)

		// Act
		await backend.close(timeout())

		// Assert
		await expect(running).rejects.toThrow()
		expect(await reopen().list(timeout())).toEqual([])
		expect(await sandboxDirectories(directory)).toEqual([])
	})

	test('closes while a create never finishes, and leaves nothing behind', async () => {
		// Arrange
		const { backend, directory, reopen } = await backendOnFakeRunsc({ hangOn: 'run' })
		const creating = backend.create(specification, new AbortController().signal)
		creating.catch(() => undefined)

		// Act
		await backend.close(timeout())

		// Assert
		await expect(creating).rejects.toThrow()
		expect(await reopen().list(timeout())).toEqual([])
		expect(await sandboxDirectories(directory)).toEqual([])
	})

	test('keeps paused sandboxes on close, for the next start to find', async () => {
		// Arrange
		const { backend, reopen } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())
		await sandbox.pause(timeout())

		// Act
		await backend.close(timeout())

		// Assert
		expect(await reopen().list(timeout())).toEqual([{ id: sandbox.id, state: 'paused' }])
	})

	test('remove clears a paused sandbox', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		const sandbox = await backend.create(specification, timeout())
		await sandbox.pause(timeout())

		// Act
		await backend.remove(sandbox.id, timeout())

		// Assert
		expect(await backend.list(timeout())).toEqual([])
	})

	test('remove refuses anything that is not a sandbox id', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()

		// Act
		const removing = backend.remove('../images', timeout())

		// Assert
		await expect(removing).rejects.toThrow("isn't a mesh-flow sandbox id")
	})

	test('refuses new work once closed', async () => {
		// Arrange
		const { backend } = await backendOnFakeRunsc()
		await backend.close(timeout())

		// Act
		const creating = backend.create(specification, timeout())

		// Assert
		await expect(creating).rejects.toThrow('closed')
	})
})
