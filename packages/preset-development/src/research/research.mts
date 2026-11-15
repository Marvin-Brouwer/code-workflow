import { workspace } from '@mesh-flow/core'

/**
 * Research is a folder of Markdown files, not data. `succeed(Research)` only takes it once the
 * folder holds at least one file, and the result renders in later prompts as the folder with its
 * files, so the planner reads as much of it as it needs.
 *
 * In code, the result is a workspace folder, whose files can be listed and read.
 *
 * @example For an agent
 * ```ts
 * const research = await planner.loop`Research ${story}. Write your notes in ${Research}, then ${succeed(Research)}.`
 * ```
 *
 * @example From code
 * ```ts
 * const notes = await Promise.all((await Research.files()).map((note) => note.read()))
 * await jira.comment(story, notes.join('\n\n'), { key: 'research' })
 * ```
 */
export const Research = workspace.folder('research', {
	description: 'Research notes: related issues, affected repositories, open questions',
	minFiles: 1,
})
