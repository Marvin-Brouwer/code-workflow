import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool, toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import { IssueKey } from '../tools/issue-key.mts'
import type { IssueData, PostedComment } from '../tools/issue-tools.mts'
import { issueMarkdownOf } from './markdown.mts'

/** Names an issue by its key, such as `PROJ-123`: the `key` parameter of a workflow. */
export const key = IssueKey

/**
 * The parameters of a workflow that works on one Jira issue, `{ key }`, so a workflow declares
 * them in one word and `jira.onIssueLabeled` can start it.
 *
 * ```ts
 * export const develop = workflow('develop', JiraIssueParameters, async ({ parameters }) => {
 * 	const story = await jira.collect(parameters.key)
 * })
 * ```
 */
export const JiraIssueParameters = Object.freeze({ key: IssueKey })
export type JiraIssueParameters = typeof JiraIssueParameters

/** An issue, by its key or as collected. */
export type IssueRef = IssueKey | { readonly key: IssueKey }

/** Where collected issues are dumped, for agents to read. */
const issuesFolder = workspace.folder('jira', { description: 'the Jira issues this run read, one Markdown file each' })

/**
 * A collected issue: what Jira has, and its Markdown dump in the workspace, which is how it appears
 * in a prompt. Its attachments carry no bytes: the images are files next to the dump, and an
 * attachment's `file` is where, relative to the dump's folder.
 */
export interface JiraIssue extends IssueData {
	/** The dump, relative to the workspace. */
	readonly path: string
	/** The dump's absolute path, which is how it renders in a prompt. */
	[toPrompt](): string
}

/**
 * Collects an issue: reads it from Jira, with its comments, links and subtasks, and writes it as
 * Markdown into `jira/` in the workspace. In a prompt it renders as that file's absolute path, so
 * the agent reads as much of it as it needs, also from inside a checkout.
 *
 * ```ts
 * const story = await jira.collect(parameters.key)
 * await planner.loop`Plan ${story}.`
 * ```
 */
export async function collect(issue: IssueRef, context?: ToolContext): Promise<JiraIssue> {
	const { attachments, ...data } = await stubs.getIssue({ key: keyOf(issue) }, context)
	const file = workspace.file(`${issuesFolder.path}/${data.key}.md`)
	const location = file.location()
	// The images go next to the Markdown, which links to them by these paths.
	const folder = path.dirname(location)
	for (const { file: relative, data: base64 } of attachments) {
		if (relative === undefined || base64 === undefined) continue
		const image = path.resolve(folder, relative)
		if (!image.startsWith(path.join(folder, data.key) + path.sep))
			throw new Error(`${data.key}'s attachment ${relative} would be written outside its folder.`)
		await mkdir(path.dirname(image), { recursive: true })
		await writeFile(image, Buffer.from(base64, 'base64'))
	}
	const collected = { ...data, attachments: attachments.map(({ data: _bytes, ...attachment }) => attachment) }
	await file.write(issueMarkdownOf(collected))
	return Object.freeze({ ...collected, path: file.path, [toPrompt]: () => location })
}

/**
 * The agent's form of {@link collect}: dumps an issue to Markdown in the workspace and returns the
 * dump's absolute path, for an agent that found the issue with `jira.search` or in a link.
 */
export const dump = tool('jiraDump', {
	description: 'Writes a Jira issue, with its comments, links and subtasks, as Markdown into the workspace and returns the file',
	input: z.object({ key: IssueKey }),
	action: async ({ key: issueKey }, context) => ({ path: (await collect(issueKey, context))[toPrompt]() }),
})

/**
 * Comments on an issue, in Markdown. With a `key`, commenting again with the same key updates the
 * earlier comment instead of adding one, so a rerun stays tidy. Every comment ends in a footer
 * that names mesh-flow and the run.
 */
export function comment(
	issue: IssueRef,
	body: string,
	options: { readonly key?: string } = {},
	context?: ToolContext,
): Promise<PostedComment> {
	return stubs.commentOnIssue({ key: keyOf(issue), body, ...(options.key === undefined ? {} : { commentKey: options.key }) }, context)
}

/**
 * Moves an issue to `status`, such as `In Progress`, through the transition of its workflow that
 * leads there. Does nothing when the issue already has that status, so a rerun is safe. Throws,
 * naming the statuses it can move to, when no transition leads there.
 */
export async function transition(issue: IssueRef, status: string, context?: ToolContext): Promise<{ readonly moved: boolean }> {
	const { moved } = await stubs.transitionIssue({ key: keyOf(issue), status }, context)
	return { moved }
}

function keyOf(issue: IssueRef): IssueKey {
	return typeof issue === 'string' ? issue : issue.key
}
