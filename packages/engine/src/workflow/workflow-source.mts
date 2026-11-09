import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { create } from 'tar'
import type { RunSource } from '../runs/run-record.mts'
import { runOnHost } from './run-on-host.mts'

/**
 * The git files of a workflow repository: tracked files and untracked ones that aren't ignored, as
 * they are on disk now. So `node_modules` and other ignored files stay out, and uncommitted
 * changes are in.
 */
export async function listSourceFiles(directory: string, abortSignal: AbortSignal): Promise<string[]> {
	const listed = await runOnHost('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], directory, abortSignal)
	// Files deleted on disk are still listed until the deletion is committed.
	const files = listed.split('\0').filter((file) => file.length > 0 && existsSync(path.join(directory, file)))
	// Sorted, so the source key doesn't depend on git's order. The array is this function's own, and
	// `toSorted` needs a newer `lib` than the repository's.
	// oxlint-disable-next-line unicorn/no-array-sort
	return files.sort()
}

/**
 * Packs the git files of a workflow repository into a tarball, with the commit they are on and
 * `dirty` set when there are uncommitted changes.
 */
export async function packWorkflowSource(directory: string, tarball: string, abortSignal: AbortSignal): Promise<RunSource> {
	const commit = (await runOnHost('git', ['rev-parse', 'HEAD'], directory, abortSignal)).trim()
	const status = await runOnHost('git', ['status', '--porcelain', '--', '.'], directory, abortSignal)
	const files = await listSourceFiles(directory, abortSignal)
	await mkdir(path.dirname(tarball), { recursive: true })
	// tar takes no signal; packing a repository without node_modules is quick and local.
	abortSignal.throwIfAborted()
	await create({ gzip: true, portable: true, cwd: directory, file: tarball }, files)
	return { directory, commit, dirty: status.trim().length > 0 }
}

/**
 * Names the workflow source as it is on disk now: a SHA-256 of every git file's path and content.
 * On a clean checkout it changes with the commit and nothing else; uncommitted changes change it
 * too, so a description is never reused for code it wasn't made from.
 */
export async function sourceKey(directory: string, abortSignal: AbortSignal): Promise<string> {
	const hash = createHash('sha256')
	for (const file of await listSourceFiles(directory, abortSignal)) {
		const content = await readFile(path.join(directory, file), { signal: abortSignal })
		hash.update(`${file}\0${String(content.length)}\0`).update(content)
	}
	return hash.digest('hex')
}
