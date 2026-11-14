import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { gitCommand } from '@mesh-flow/git'

/** Enough of the hash to tell two states of a checkout apart. */
const fingerprintLength = 16

/**
 * What an untracked entry holds, for the fingerprint: a file's content, a link's target, and
 * nothing more than the name for anything else, such as a nested repository's directory. An entry
 * that is gone by the time it is read, such as a file a build that runs alongside made and removed
 * again, is `undefined`: it isn't part of the state.
 */
async function contentOf(entryPath: string, abortSignal: AbortSignal): Promise<string | Buffer | undefined> {
	try {
		const entry = await lstat(entryPath)
		if (entry.isSymbolicLink()) return `link:${await readlink(entryPath)}`
		return entry.isFile() ? await readFile(entryPath, { signal: abortSignal }) : ''
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
}

/** Whether a file system error says the entry isn't there. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A checkout's state, and the commit its changes are against. */
export interface TreeState {
	readonly fingerprint: string
	/** The merge base of the branch and `origin/<defaultBranch>`. */
	readonly base: string
}

/** What `treeState` takes besides the checkout. */
export interface TreeStateOptions {
	readonly abortSignal: AbortSignal
	/** Files outside the checkout that are part of the state too, such as the deviations file. */
	readonly files?: readonly string[]
}

/**
 * A short fingerprint of what a checkout holds against where its branch left
 * `origin/<defaultBranch>`, their merge base: its commit, its changes, committed or not, its
 * untracked files, and `options.files`. Commits on the default branch since don't count. The same
 * changes give the same fingerprint, and any change gives another, so a review loop that renders
 * it is a loop of its own per state.
 */
export async function treeState(directory: string, defaultBranch: string, options: TreeStateOptions): Promise<TreeState> {
	const { abortSignal } = options
	const git = async (args: readonly string[]) => (await gitCommand(args, { cwd: directory, abortSignal })).stdout
	const head = await git(['rev-parse', 'HEAD'])
	const base = await mergeBase(directory, defaultBranch, abortSignal)
	const diff = await git(['diff', '--binary', base])
	const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).toSorted()
	const hash = createHash('sha256').update(head).update('\0').update(diff)
	const addEntry = async (name: string, entryPath: string) => {
		const content = await contentOf(entryPath, abortSignal)
		if (content !== undefined) hash.update(`\0${name}\0`).update(content)
	}
	for (const file of untracked) await addEntry(file, path.join(directory, file))
	for (const file of options.files ?? []) await addEntry(file, file)
	return { fingerprint: hash.digest('hex').slice(0, fingerprintLength), base }
}

/** The commit the checkout's branch left `origin/<defaultBranch>` at: what its changes are against. */
async function mergeBase(directory: string, defaultBranch: string, abortSignal: AbortSignal): Promise<string> {
	const { stdout } = await gitCommand(['merge-base', `origin/${defaultBranch}`, 'HEAD'], { cwd: directory, abortSignal })
	return stdout.trim()
}
