import type { z } from 'zod'
import type { WorkspaceFolder } from '../workspace/workspace-folder.mts'
import { makeExit, type Exit } from './exit.mts'

/**
 * Lets the agent finish:
 * - `succeed()`: with nothing;
 * - `succeed(schema)`: with data that matches the schema. Data that doesn't goes back to the agent
 *   as an error, and the loop's result is the parsed data;
 * - `succeed(folder)`: once the folder meets its options (such as `minFiles`). The loop's result is
 *   the folder.
 *
 * ```ts
 * const research = await planner.loop`Write your findings in ${Research}, then ${succeed(Research)}.`
 * ```
 */
export function succeed(): Exit<void>
export function succeed<T extends z.ZodType>(schema: T): Exit<z.output<T>>
export function succeed(folder: WorkspaceFolder): Exit<WorkspaceFolder>
export function succeed(result?: z.ZodType | WorkspaceFolder): Exit<unknown> {
	if (result === undefined) return makeExit({ kind: 'succeed' })
	if (isFolder(result)) return makeExit({ kind: 'succeed', folder: result })
	return makeExit({ kind: 'succeed', schema: result })
}

function isFolder(value: z.ZodType | WorkspaceFolder): value is WorkspaceFolder {
	return 'files' in value
}
