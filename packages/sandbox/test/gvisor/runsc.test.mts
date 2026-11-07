import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { runscOrThrow } from '../../src/gvisor/runsc.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

/** A runsc that writes `lines` numbered lines to stderr and fails. */
async function failingRunsc(directory: string, lines = 1): Promise<string[]> {
	const file = path.join(directory, 'failing-runsc')
	await writeFile(file, `#!/bin/sh\ni=1\nwhile [ $i -le ${String(lines)} ]; do echo "line $i" >&2; i=$((i + 1)); done\nexit 1\n`)
	await chmod(file, 0o755)
	return [file]
}

function timeout(): AbortSignal {
	return AbortSignal.timeout(5000)
}

describe('runscOrThrow', () => {
	test('a failed call carries stderr', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const config = { command: await failingRunsc(directory), root: directory }

		// Act
		const call = runscOrThrow(config, ['delete', 'id'], { signal: timeout() })

		// Assert
		await expect(call).rejects.toThrow('runsc delete exited with 1: line 1')
	})

	test('a failed call with a log file carries its last 20 lines', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const config = { command: await failingRunsc(directory, 25), root: directory }
		const logFile = path.join(directory, 'init.log')

		// Act
		const call = runscOrThrow(config, ['run', 'id'], { signal: timeout(), logFile })

		// Assert
		const lines = Array.from({ length: 20 }, (_, index) => `line ${String(index + 6)}`)
		await expect(call).rejects.toThrow(`runsc run exited with 1: ${lines.join('\n')}`)
		await expect(call).rejects.not.toThrow('line 5\n')
	})

	test('a log file the engine can no longer write is replaced', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const config = { command: await failingRunsc(directory), root: directory }
		const logFile = path.join(directory, 'init.log')
		await writeFile(logFile, 'an earlier run\n')
		await chmod(logFile, 0o444)

		// Act
		const call = runscOrThrow(config, ['restore', 'id'], { signal: timeout(), logFile })

		// Assert
		await expect(call).rejects.toThrow('runsc restore exited with 1: line 1')
		expect(await readFile(logFile, 'utf8')).toBe('line 1\n')
	})
})
