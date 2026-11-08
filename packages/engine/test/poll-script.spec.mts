import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { pollScript, runtimeGoneExitCode } from '../src/mailbox/poll-script.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const run = promisify(execFile)

/** Runs the poll script on the host and returns its exit code. */
async function poll(directory: string, pidFile: string): Promise<number> {
	const args = [path.join(directory, 'outbox.jsonl'), pidFile, '0', '8', path.join(directory, 'polls')]
	return run('sh', ['-c', pollScript, 'poll', ...args]).then(
		() => 0,
		(error: unknown) => {
			if (error instanceof Error && 'code' in error && typeof error.code === 'number') return error.code
			throw error
		},
	)
}

describe.skipIf(process.platform !== 'linux')('the poll script', () => {
	test('sees a runtime that died as a zombie, also when its name has spaces', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const pidFile = path.join(directory, 'runtime.pid')
		// The parent execs sleep, which never reaps the runtime, so it stays a zombie.
		const parent = execFile('sh', [
			'-c',
			`node -e 'process.title = "npm exec mesh-flow-runtime"' & echo $! > "$1"; exec sleep 30`,
			'sh',
			pidFile,
		])
		onTestFinished(() => {
			parent.kill()
		})
		await vi.waitFor(async () => {
			const { stdout } = await run('sh', ['-c', 'cat "/proc/$(cat "$1")/stat"', 'sh', pidFile])
			expect(stdout).toMatch(/\(npm exec mesh-f\) Z /)
		})

		// Act
		const exitCode = await poll(directory, pidFile)

		// Assert
		expect(exitCode).toBe(runtimeGoneExitCode)
	})

	test('takes a runtime whose pid is not written yet for alive', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const pidFile = path.join(directory, 'runtime.pid')
		await writeFile(pidFile, '')

		// Act
		const exitCode = await poll(directory, pidFile)

		// Assert
		expect(exitCode).toBe(0)
	})
})
