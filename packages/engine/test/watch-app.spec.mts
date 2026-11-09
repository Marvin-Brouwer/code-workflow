import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { watchApp } from '../src/cli/watch-app.mts'
import { deferred } from './support/deferred.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** Longer than watchApp gathers changes for. */
const settledMs = 1_000

/** How long a test waits for a call. */
const waitForCallMs = settledMs * 3

/** The resource Node holds for each `fs.watch`. */
const watchResource = 'FSEventWrap'

/** An app folder with a source folder and dependencies, watched until the test ends. */
async function watchedApp(changed: () => Promise<void> = () => Promise.resolve()) {
	const directory = await temporaryDirectory()
	await mkdir(path.join(directory, 'workflows'))
	await mkdir(path.join(directory, 'node_modules', 'some-package'), { recursive: true })
	const calls = vi.fn(changed)
	const log = vi.fn<(message: string) => void>()
	const controller = new AbortController()
	onTestFinished(() => {
		controller.abort()
	})
	await watchApp({ directory, changed: calls, log, stopped: () => undefined, abortSignal: controller.signal })
	return { directory, calls, log, controller }
}

// Recursive watches need Linux, macOS or Windows; the CI runs Linux and Windows.
describe('watchApp', () => {
	test('calls once for a burst of changes, and not for dependencies', async () => {
		// Arrange
		const { directory, calls } = await watchedApp()

		// Act
		await writeFile(path.join(directory, 'node_modules', 'some-package', 'index.js'), '')
		await writeFile(path.join(directory, 'workflows', 'a.mts'), '')
		await writeFile(path.join(directory, 'workflows', 'b.mts'), '')
		await writeFile(path.join(directory, 'main.mts'), '')

		// Assert
		await vi.waitFor(() => {
			expect(calls).toHaveBeenCalledOnce()
		}, waitForCallMs)
	})

	test('calls once more for changes while a call is going, and goes on after one fails', async () => {
		// Arrange
		const first = deferred<undefined>()
		let count = 0
		const { directory, calls, log } = await watchedApp(async () => {
			count += 1
			if (count === 1) {
				await first.promise
				throw new Error('broken build')
			}
		})
		await writeFile(path.join(directory, 'main.mts'), '1')
		await vi.waitFor(() => {
			expect(calls).toHaveBeenCalledOnce()
		}, waitForCallMs)

		// Act
		await writeFile(path.join(directory, 'main.mts'), '2')
		await delay(settledMs)
		await writeFile(path.join(directory, 'main.mts'), '3')
		await delay(settledMs)
		first.resolve(undefined)

		// Assert
		await vi.waitFor(() => {
			expect(calls).toHaveBeenCalledTimes(2)
		}, waitForCallMs)
		expect(log).toHaveBeenCalledWith('Rebuilding failed: broken build')
	})

	test('watches a folder made after it started', async () => {
		// Arrange
		const { directory, calls } = await watchedApp()
		await mkdir(path.join(directory, 'agents'))
		await delay(settledMs)
		await vi.waitFor(() => {
			expect(calls).toHaveBeenCalledOnce()
		}, waitForCallMs)

		// Act
		await writeFile(path.join(directory, 'agents', 'planner.mts'), '')

		// Assert
		await vi.waitFor(() => {
			expect(calls).toHaveBeenCalledTimes(2)
		}, waitForCallMs)
	})

	test('stops calling, and holds no timer or watch, once aborted', async () => {
		// Arrange
		const { directory, calls, controller } = await watchedApp()
		await writeFile(path.join(directory, 'main.mts'), '')

		// Act
		controller.abort()
		await delay(settledMs)

		// Assert
		expect(calls).not.toHaveBeenCalled()
		expect(process.getActiveResourcesInfo().filter((resource) => resource === watchResource)).toEqual([])
	})
})
