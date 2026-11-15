import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool, toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import { IssueKey } from '../tools/issue-key.mts'
import type { IssueData, PostedComment } from '../tools/issue-tools.mts'
import { issueMarkdownOf } from './markdown.mts'

/**
 * Names an issue by its key, such as `PROJ-123`: a zod schema, for the `key` parameter of a
 * workflow, or for checking a key that came from elsewhere.
 *
 * @example A workflow parameter
 * ```ts
 * export const develop = workflow('develop', { key: jira.key }, async ({ parameters }) => {
 * 	const story = await jira.collect(parameters.key)
 * })
 * ```
 *
 * @example Checking a key
 * ```ts
 * const parsed = jira.key.safeParse(input)
 * if (!parsed.success) throw new Error(`${input} is not a Jira issue key, such as PROJ-123.`)
 * ```
 */
export const key = IssueKey

/**
 * The parameters of a workflow that works on one Jira issue, `{ key }`, so a workflow declares
 * them in one word and `jira.onIssueLabeled` can start it. Add parameters of your own next to it
 * with a spread; `jira.onIssueLabeled` starts a workflow only while the others are optional.
 *
 * @example
 * ```ts
 * import { jira, JiraIssueParameters } from '@mesh-flow/atlassian'
 * import { workflow } from '@mesh-flow/core'
 * import { z } from 'zod'
 *
 * export const develop = workflow('develop', JiraIssueParameters, async ({ parameters }) => {
 * 	const story = await jira.collect(parameters.key)
 * })
 *
 * export const estimate = workflow('estimate', { ...JiraIssueParameters, team: z.string().optional() }, async ({ parameters }) => {
 * 	// ...
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
 * Collects an issue: reads it from Jira, with its comments, links, subtasks and attachments, and
 * writes it as Markdown into `jira/<key>.md` in the workspace, with its facts as frontmatter. Its
 * image attachments on the site are downloaded next to it, into `jira/<key>/`, up to a size limit
 * per image and per issue, and the Markdown links to them there; larger images and other files
 * are listed with their URL. A mention reads as
 * `` `@mention({ name, email, id })` ``, without the email when the site keeps it private.
 * The whole of what an agent reads is in `test/jira.spec.md` in the repository:
 * https://github.com/Marvin-Brouwer/code-workflow/blob/main/packages/atlassian/test/jira.spec.md
 *
 * Collecting an issue again writes it again, as it is in Jira by then. Runs on the host, through
 * the gateway, so the token never reaches the sandbox.
 *
 * In a prompt the result renders as the Markdown file's absolute path, so the agent reads as much of
 * it as it needs, also from inside a checkout. In code, its fields are what Jira has, ready to use.
 *
 * @param issue - The issue's key, such as `PROJ-123`, or anything with a `key`, such as an issue
 * collected before.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The issue, with `path` the Markdown file relative to the workspace.
 * @throws When Jira has no such issue, or the token can't read it.
 *
 * @example From code
 * ```ts
 * const story = await jira.collect(parameters.key)
 * if (story.labels.includes('blocked')) return
 * const linked = story.links.filter((link) => link.relation === 'is blocked by' && link.status !== 'Done')
 * if (linked.length > 0) await jira.comment(story, `Waiting on ${linked.map((link) => link.key).join(', ')}.`)
 * ```
 *
 * @example In a prompt
 * ```ts
 * const story = await jira.collect(parameters.key)
 * const research = await researcher.loop`Research ${story}, then hand in with ${succeed(Research)}.`
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
 * The agent's form of {@link collect}: dumps an issue to Markdown in the workspace and returns
 * `{ path }`, the dump's absolute path, for an agent that found the issue with `jira.search` or in a
 * link and wants to read it. Code that wants the issue's fields calls `jira.collect` instead.
 *
 * Input: `{ key }`, the issue's key, such as `PROJ-123`.
 *
 * @throws When Jira has no such issue, or the token can't read it.
 *
 * @example From code
 * ```ts
 * const { path } = await jira.dump({ key: 'PROJ-123' })
 * ```
 *
 * @example For an agent
 * ```ts
 * await researcher.loop`Research ${story}. Find related issues with ${jira.search} and read the ones that matter with ${jira.dump}.`
 * ```
 */
export const dump = tool('jiraDump', {
	description: 'Writes a Jira issue, with its comments, links and subtasks, as Markdown into the workspace and returns the file',
	input: z.object({ key: IssueKey }),
	action: async ({ key: issueKey }, context) => ({ path: (await collect(issueKey, context))[toPrompt]() }),
})

/**
 * Comments on an issue, in Markdown, which is turned into what the site takes: Atlassian's document
 * format on Cloud, wiki markup on Data Center. Every comment ends in a footer that names mesh-flow
 * and the run, so a reader knows where it came from.
 *
 * With a `key`, commenting again with the same key updates the earlier comment instead of adding a
 * new one, so a rerun, or a status that changes as the run goes on, keeps one comment. Without one,
 * every call adds a comment.
 *
 * @param issue - The issue's key, such as `PROJ-123`, or anything with a `key`, such as an issue
 * collected before.
 * @param body - The comment, in Markdown.
 * @param options - `key`: names the comment within the issue, such as `status` or `mr-team/api`, so
 * a later comment with the same key replaces it.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The comment's id and its URL.
 * @throws When Jira has no such issue, or the token may not comment on it.
 *
 * @example A comment per run step, kept up to date
 * ```ts
 * await jira.comment(story, 'Picked up: researching.', { key: 'status' })
 * // ...
 * await jira.comment(story, `Merge requests are open:\n\n${links.join('\n')}`, { key: 'status' })
 * ```
 *
 * @example A comment of its own
 * ```ts
 * const { url } = await jira.comment('PROJ-123', `Released in **${version}**.`)
 * ```
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
 * leads there. Status names are compared without regard to case. Does nothing when the issue
 * already has that status, so a rerun is safe.
 *
 * @param issue - The issue's key, such as `PROJ-123`, or anything with a `key`, such as an issue
 * collected before.
 * @param status - The status to move to, by its name on the board.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns `{ moved: true }` when the issue was moved, `{ moved: false }` when it already had the status.
 * @throws When no transition leads to `status` from where the issue is, naming the statuses it can
 * move to; and when Jira has no such issue.
 *
 * @example
 * ```ts
 * const { moved } = await jira.transition(story, 'In Progress')
 * if (moved) await jira.comment(story, 'Picked up by mesh-flow.', { key: 'status' })
 * ```
 */
export async function transition(issue: IssueRef, status: string, context?: ToolContext): Promise<{ readonly moved: boolean }> {
	const { moved } = await stubs.transitionIssue({ key: keyOf(issue), status }, context)
	return { moved }
}

function keyOf(issue: IssueRef): IssueKey {
	return typeof issue === 'string' ? issue : issue.key
}
