import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { gitCommand } from '@mesh-flow/git'

/** Enough of the hash to tell two states of a checkout apart. */
const fingerprintLength = 16

/**
 * What an untracked entry holds, for the fingerprint: a file's content, a link's target, and
 * nothing more than the name for anything else, such as a nested repository's directory.
 */
async function contentOf(file: string, abortSignal: AbortSignal): Promise<string | Buffer> {
	const entry = await lstat(file)
	if (entry.isSymbolicLink()) return `link:${await readlink(file)}`
	return entry.isFile() ? readFile(file, { signal: abortSignal }) : ''
}

/**
 * A short fingerprint of what a checkout holds against `origin/<defaultBranch>`: its commit, its
 * changes, committed or not, and its untracked files. The same changes give the same fingerprint,
 * and any change gives another, so a review loop that renders it is a loop of its own per state.
 */
export async function treeState(directory: string, defaultBranch: string, abortSignal: AbortSignal): Promise<string> {
	const git = async (args: readonly string[]) => (await gitCommand(args, { cwd: directory, abortSignal })).stdout
	const head = await git(['rev-parse', 'HEAD'])
	const diff = await git(['diff', '--binary', `origin/${defaultBranch}`])
	const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).toSorted()
	const hash = createHash('sha256').update(head).update('\0').update(diff)
	for (const file of untracked) hash.update(`\0${file}\0`).update(await contentOf(path.join(directory, file), abortSignal))
	return hash.digest('hex').slice(0, fingerprintLength)
}
