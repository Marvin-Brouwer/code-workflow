export interface WorkspaceFile {
	readonly kind: 'file'
	readonly path: string
	append(entry: object): Promise<void>
}
export interface WorkspaceFolder {
	readonly kind: 'folder'
	readonly path: string
	files(): Promise<readonly WorkspaceFile[]>
}

/**
 * The run's workspace in the sandbox.
 *
 * Interpolated in a prompt, a workspace value renders as what an agent needs to find it:
 * - a file renders as its path;
 * - a folder renders as its path plus a listing of the files in it, e.g.
 *   "the Markdown files in research/: overview.md, repositories.md, open-questions.md".
 *
 * A folder also works as an exit schema: `succeed(folder)` lets the agent finish once the folder
 * meets its constraints, and the loop's result is the folder itself.
 */
export const workspace: {
	file(path: string): WorkspaceFile
	folder(path: string, options?: { description?: string; minFiles?: number }): WorkspaceFolder
}
