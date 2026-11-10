import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** What the directories this package makes for a file in passing are called. */
const scratchPrefix = 'mesh-flow-github-'

/** Runs `use` with the path of `fileName` in a fresh directory, which is removed afterwards. */
export async function withScratchFile<T>(fileName: string, use: (file: string) => Promise<T>): Promise<T> {
	const scratch = await mkdtemp(path.join(tmpdir(), scratchPrefix))
	try {
		return await use(path.join(scratch, fileName))
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}
