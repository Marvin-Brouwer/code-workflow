import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/**
 * Copies a tarball to `target` under a temporary name next to it, then renames it into place, so
 * `target` is never seen half written: not by a reader at the same time, not after a crash. An
 * abort leaves no temporary file behind.
 */
export async function copyTarball(source: string, target: string, abortSignal: AbortSignal): Promise<void> {
	const partial = `${target}.${randomBytes(6).toString('hex')}.partial`
	try {
		await pipeline(createReadStream(source), createWriteStream(partial), { signal: abortSignal })
		await rename(partial, target)
	} catch (error) {
		await rm(partial, { force: true })
		throw error
	}
}
