import { workspace } from '@mesh-flow/core'

/**
 * Research is a folder of Markdown files, not data. `succeed(Research)` only takes it once the
 * folder holds at least one file, and the result renders in later prompts as the folder with its
 * files, so the planner reads as much of it as it needs.
 *
 * ```ts
 * const research = await planner.loop`Research ${story}. Write your notes in ${Research}, then ${succeed(Research)}.`
 * ```
 */
export const Research = workspace.folder('research', {
	description: 'Research notes: related issues, affected repositories, open questions',
	minFiles: 1,
})
