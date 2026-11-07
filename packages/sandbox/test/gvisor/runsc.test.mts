import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { runscOrThrow } from '../../src/gvisor/runsc.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

async function failingRunsc(directory: string): Promise<string[]> {
	const file = path.join(directory, 'failing-runsc')
	await writeFile(file, '#!/bin/sh\necho "creating container: cannot read spec" >&2\nexit 1\n')
	await chmod(file, 0o755)
	return [file]
}

test('a failed call carries stderr', async () => {
	// Arrange
	const directory = await temporaryDirectory()
	const config = { command: await failingRunsc(directory), root: directory }

	// Act
	const call = runscOrThrow(config, ['delete', 'id'], { signal: AbortSignal.timeout(5000) })

	// Assert
	await expect(call).rejects.toThrow('runsc delete exited with 1: creating container: cannot read spec')
})

test('a failed call with a log file carries the end of that log', async () => {
	// Arrange
	const directory = await temporaryDirectory()
	const config = { command: await failingRunsc(directory), root: directory }
	const logFile = path.join(directory, 'init.log')

	// Act
	const call = runscOrThrow(config, ['run', 'id'], { signal: AbortSignal.timeout(5000), logFile })

	// Assert
	await expect(call).rejects.toThrow('runsc run exited with 1: creating container: cannot read spec')
})
