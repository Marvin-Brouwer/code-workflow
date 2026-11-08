import { workspaceFile } from './workspace-file.mts'
import { workspaceFolder } from './workspace-folder.mts'

/**
 * The run's workspace in the sandbox: the agents' working directory, where checkouts, research
 * and plans live.
 *
 * ```ts
 * export const Research = workspace.folder('research', { description: 'Research notes', minFiles: 1 })
 * export const deviations = workspace.file('plan-deviations.md')
 * ```
 *
 * In a prompt, a file renders as its path and a folder as its path and its files, such as
 * `research/ (Research notes), with overview.md, repositories.md`.
 */
export const workspace = Object.freeze({
	file: workspaceFile,
	folder: workspaceFolder,
})
