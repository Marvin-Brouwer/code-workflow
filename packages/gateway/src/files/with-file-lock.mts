import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import lockfile from 'proper-lockfile'

/** How long a change waits for another process's: about 3 s, for the CLI and the engine changing the same file. */
const lockRetries = { retries: 20, minTimeout: 25, maxTimeout: 250 }

/** Runs `change` while this process alone may change `file`, in its folder, which is made when it's missing. */
export async function withFileLock<T>(file: string, change: () => Promise<T>): Promise<T> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
	const release = await lockfile.lock(path.dirname(file), { lockfilePath: `${file}.lock`, retries: lockRetries })
	try {
		return await change()
	} finally {
		await release()
	}
}
