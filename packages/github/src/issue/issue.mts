import { tool, toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import type { z } from 'zod'
import { stubs } from '../stubs.mts'
import { IssueRef, type IssueData, type PostedComment } from '../tools/issue-tools.mts'

/** Names an issue, `{ repository: 'owner/name', number }`: what a workflow takes as a parameter. */
export const issue = IssueRef
export type { IssueRef }

/** Where collected issues are dumped, for agents to read. */
const issuesFolder = workspace.folder('issues', { description: 'the issues this run works on, one Markdown file each' })

/** A collected issue: what GitHub has, and its Markdown dump in the workspace, which is how it appears in a prompt. */
export interface Issue extends IssueData {
	/** The dump, relative to the workspace. */
	readonly path: string
	[toPrompt](): string
}

/**
 * Collects an issue: reads it from GitHub and writes it as Markdown into `issues/` in the
 * workspace. In a prompt it renders as that file's path, so the agent reads as much of it as it
 * needs ([design: Context](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#context)).
 *
 * ```ts
 * const issue = await github.collect(parameters.issue)
 * await developer.loop`Fix ${issue} in ${repository}.`
 * ```
 */
export const collect = tool('githubCollect', {
	description: 'Reads a GitHub issue and writes it as Markdown into the workspace',
	input: IssueRef,
	action: async (ref, context): Promise<Issue> => {
		const data = await stubs.getIssue(ref, context)
		const file = workspace.file(`${issuesFolder.path}/${fileName(data)}`)
		await file.write(markdownOf(data))
		return Object.freeze({ ...data, path: file.path, [toPrompt]: () => file.path })
	},
})

/**
 * Comments on an issue or a pull request. With a `key`, commenting again with the same key updates
 * the earlier comment instead of adding one, so a rerun stays tidy.
 */
export function comment(
	on: IssueRef,
	body: string,
	options: { readonly key?: string } = {},
	context?: ToolContext,
): Promise<PostedComment> {
	return stubs.commentOnIssue(
		{ repository: on.repository, number: on.number, body, ...(options.key === undefined ? {} : { key: options.key }) },
		context,
	)
}

/** Adds labels to an issue. Labels it already has stay as they are. */
export async function label(on: IssueRef, labels: readonly string[], context?: ToolContext): Promise<readonly string[]> {
	return (await stubs.labelIssue({ repository: on.repository, number: on.number, labels: [...labels] }, context)).labels
}

/** Closes an issue. Closing a closed issue does nothing. */
export async function close(on: IssueRef, context?: ToolContext): Promise<void> {
	await stubs.closeIssue({ repository: on.repository, number: on.number }, context)
}

function fileName(data: IssueData): string {
	return `${data.repository.replaceAll('/', '--')}-${String(data.number)}.md`
}

/** The issue as Markdown: a heading with its number and title, its facts, then its body. */
export function markdownOf(data: IssueData): string {
	const labels = data.labels.length === 0 ? 'none' : data.labels.join(', ')
	return [
		`# #${String(data.number)}: ${data.title}`,
		'',
		`- Repository: ${data.repository}`,
		`- URL: ${data.url}`,
		`- Author: ${data.author}`,
		`- State: ${data.state}`,
		`- Labels: ${labels}`,
		`- Created: ${data.createdAt}`,
		'',
		data.body.trim() === '' ? '(no description)' : data.body.trim(),
		'',
	].join('\n')
}

/** The issue parameter's schema, for `workflow(name, { issue: github.issue }, ...)`. Exported for type tests. */
export type IssueParameter = z.input<typeof IssueRef>
