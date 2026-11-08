import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { create } from 'tar'
import type { RunSource } from '../runs/run-record.mts'
import { runOnHost } from './run-on-host.mts'

/**
 * Packs the git files of a workflow repository into a tarball: tracked files and untracked ones
 * that aren't ignored, as they are on disk now. So `node_modules` and other ignored files stay out,
 * and uncommitted changes are in, with `dirty` set to say so.
 */
export async function packWorkflowSource(directory: string, tarball: string, signal: AbortSignal): Promise<RunSource> {
	const commit = (await runOnHost('git', ['rev-parse', 'HEAD'], directory, signal)).trim()
	const status = await runOnHost('git', ['status', '--porcelain', '--', '.'], directory, signal)
	const listed = await runOnHost('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], directory, signal)
	// Files deleted on disk are still listed until the deletion is committed.
	const files = listed.split('\0').filter((file) => file.length > 0 && existsSync(path.join(directory, file)))
	await mkdir(path.dirname(tarball), { recursive: true })
	// tar takes no signal; packing a repository without node_modules is quick and local.
	signal.throwIfAborted()
	await create({ gzip: true, portable: true, cwd: directory, file: tarball }, files)
	return { directory, commit, dirty: status.trim().length > 0 }
}
