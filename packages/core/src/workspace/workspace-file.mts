import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '../render/to-prompt.mts'
import { onDisk, workspacePath } from './workspace-path.mts'

/**
 * A file in the run's workspace. In a prompt it renders as where it is on disk, so the agent finds
 * it from any directory, also after it changed into a checkout.
 */
export interface WorkspaceFile {
	readonly kind: 'file'
	/** Relative to the workspace, POSIX. */
	readonly path: string
	/** Where it is on disk, in the current run's workspace. Throws outside a run. */
	location(): string
	read(): Promise<string>
	/** Writes the file, making its folder when needed. */
	write(text: string): Promise<void>
	/** Appends `entry` as one line of JSON, making the file when needed. */
	append(entry: object): Promise<void>
	[toPrompt](): string
}

/**
 * A file in the run's workspace. It can be made outside a run (at module level, say); reading and
 * writing it only works inside one.
 */
export function workspaceFile(relative: string): WorkspaceFile {
	const filePath = workspacePath(relative)
	const located = (what: string) => onDisk(filePath, `${what} of workspace file ${filePath}`)
	return Object.freeze({
		kind: 'file' as const,
		path: filePath,
		location: () => located('Locating'),
		read: () => readFile(located('Reading'), 'utf8'),
		write: async (text: string) => {
			const file = located('Writing')
			await mkdir(path.dirname(file), { recursive: true })
			await writeFile(file, text)
		},
		append: async (entry: object) => {
			const file = located('Appending to')
			await mkdir(path.dirname(file), { recursive: true })
			await appendFile(file, `${JSON.stringify(entry)}\n`)
		},
		[toPrompt]: () => located('Rendering'),
	})
}
