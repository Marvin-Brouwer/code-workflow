import { readFile } from 'node:fs/promises'
import { hasErrorCode } from '../errors.mts'

/** The text in `file`, or `undefined` when there is no such file. */
export async function readTextIfExists(file: string, abortSignal: AbortSignal): Promise<string | undefined> {
	return readFile(file, { encoding: 'utf8', signal: abortSignal }).catch((error: unknown) => {
		if (hasErrorCode(error, 'ENOENT')) return undefined
		throw error
	})
}
