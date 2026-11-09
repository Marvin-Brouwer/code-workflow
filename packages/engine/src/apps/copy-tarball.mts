import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/** Random bytes in a partial file's name, so copies at the same time don't collide. */
const partialNameBytes = 6

/**
 * Copies a tarball to `target` under a temporary name next to it, then renames it into place, so
 * `target` is never seen half written: not by a reader at the same time, not after a crash. An
 * abort leaves no temporary file behind.
 */
export async function copyTarball(source: string, target: string, abortSignal: AbortSignal): Promise<void> {
	const partial = `${target}.${randomBytes(partialNameBytes).toString('hex')}.partial`
	try {
		await pipeline(createReadStream(source), createWriteStream(partial), { signal: abortSignal })
		await rename(partial, target)
	} catch (error) {
		await rm(partial, { force: true })
		throw error
	}
}
