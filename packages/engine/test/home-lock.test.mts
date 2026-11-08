import { mkdir, rm, utimes } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { controlSocketPath } from '../src/control/control-socket.mts'
import { lockHome } from '../src/serve/home-lock.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const signal = new AbortController().signal
const log = () => undefined

describe('lockHome', () => {
	test('refuses at once while another engine holds the lock and answers on its socket', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const unlock = await lockHome(home, controlSocketPath(home), log, signal)
		onTestFinished(unlock)
		const server = createServer()
		await new Promise<void>((resolve) => {
			server.listen(controlSocketPath(home), resolve)
		})
		onTestFinished(() => {
			server.close()
		})
		const started = Date.now()

		// Act
		const locking = lockHome(home, controlSocketPath(home), log, signal)

		// Assert
		await expect(locking).rejects.toThrow('already running')
		expect(Date.now() - started).toBeLessThan(500)
	})

	test('stops waiting for a lock that is going stale when its signal aborts', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const left = path.join(home, 'engine.lock')
		await mkdir(left)
		const twoSecondsAgo = new Date(Date.now() - 2_000)
		await utimes(left, twoSecondsAgo, twoSecondsAgo)
		const controller = new AbortController()

		// Act
		const locking = lockHome(home, controlSocketPath(home), log, controller.signal)
		controller.abort(new Error('Startup was cancelled.'))

		// Assert
		await expect(locking).rejects.toThrow('Startup was cancelled.')
	})

	test('takes over a lock an engine left when it died', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const left = path.join(home, 'engine.lock')
		await mkdir(left)
		const aMinuteAgo = new Date(Date.now() - 60_000)
		await utimes(left, aMinuteAgo, aMinuteAgo)

		// Act
		const unlock = await lockHome(home, controlSocketPath(home), log, signal)

		// Assert
		await expect(unlock()).resolves.toBeUndefined()
	})

	test('releases a lock that was lost without failing', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const lost = vi.fn<(message: string) => void>()
		const unlock = await lockHome(home, controlSocketPath(home), lost, signal)
		await rm(path.join(home, 'engine.lock'), { recursive: true })
		await vi.waitFor(() => {
			expect(lost).toHaveBeenCalledWith(expect.stringContaining('was lost'))
		}, 10_000)

		// Act
		const releasing = unlock()

		// Assert
		await expect(releasing).resolves.toBeUndefined()
	})
})
