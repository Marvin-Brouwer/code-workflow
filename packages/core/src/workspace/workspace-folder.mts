import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '../render/to-prompt.mts'
import { workspaceFile, type WorkspaceFile } from './workspace-file.mts'
import { toPosix } from '../run/to-posix.mts'
import { asDirectory, onDisk, workspacePath } from './workspace-path.mts'

export interface WorkspaceFolderOptions {
	/** What the folder holds, for the agent. */
	readonly description?: string
	/** As an exit (`succeed(folder)`), the agent may only finish once the folder has this many files. */
	readonly minFiles?: number
}

/**
 * A folder in the run's workspace. In a prompt it renders as where it is on disk and the files in
 * it, so the agent finds it from any directory. As an exit, `succeed(folder)` lets the agent finish
 * once the folder meets its options.
 */
export interface WorkspaceFolder {
	readonly kind: 'folder'
	/** Relative to the workspace, POSIX. */
	readonly path: string
	readonly options: WorkspaceFolderOptions
	/** Where it is on disk, in the current run's workspace. Throws outside a run. */
	location(): string
	/** The files in it and its subfolders, sorted by path. None when it doesn't exist yet. */
	files(): Promise<readonly WorkspaceFile[]>
	[toPrompt](): Promise<string>
}

/** A folder in the run's workspace. Like a file, it can be made outside a run. */
export function workspaceFolder(relative: string, options: WorkspaceFolderOptions = {}): WorkspaceFolder {
	const folderPath = workspacePath(relative)
	const located = (what: string) => onDisk(folderPath, `${what} workspace folder ${folderPath}`)
	const files = async () => {
		const directory = located('Listing')
		const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
			throw error
		})
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => toPosix(path.relative(directory, path.join(entry.parentPath, entry.name))))
			.toSorted()
			.map((name) => workspaceFile(path.posix.join(folderPath, name)))
	}
	return Object.freeze({
		kind: 'folder' as const,
		path: folderPath,
		options,
		location: () => located('Locating'),
		files,
		[toPrompt]: async () => {
			const directory = asDirectory(located('Rendering'))
			const names = (await files()).map((file) => path.posix.relative(folderPath, file.path))
			const label = options.description === undefined ? directory : `${directory} (${options.description})`
			return names.length === 0 ? `${label}, empty so far` : `${label}, with ${names.join(', ')}`
		},
	})
}
