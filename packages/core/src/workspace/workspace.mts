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
 * In a prompt, a file renders as where it is on disk and a folder as where it is and its files, such
 * as `/home/user/workspace/research/ (Research notes), with overview.md, repositories.md`. The paths
 * are absolute, so they still work once the agent changed into a checkout.
 */
export const workspace = Object.freeze({
	file: workspaceFile,
	folder: workspaceFolder,
})
