import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

/** A fresh directory, removed when the test ends. */
export async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'mesh-flow-forge-test-'))
	onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
	return directory
}
