import { tool, toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import { IssueRef, type IssueData, type PostedComment } from '../tools/issue-tools.mts'

/**
 * Names an issue, `{ repository: 'owner/name', number }`: a zod schema, for the `issue` parameter
 * of a workflow, or for checking a reference that came from elsewhere.
 *
 * @example
 * ```ts
 * import { succeed, workflow } from '@mesh-flow/core'
 * import { github } from '@mesh-flow/github'
 * import { triager } from '../agents.mts'
 *
 * export const triage = workflow('triage', { issue: github.issue }, async ({ parameters }) => {
 * 	const issue = await github.collect(parameters.issue)
 * 	await triager.loop`Triage ${issue}, then ${succeed()}.`
 * })
 * ```
 */
export const issue = IssueRef
export type { IssueRef }

/**
 * The parameters of a workflow that works on one issue, `{ issue }`, so a workflow declares them
 * in one word and `github.onIssueLabeled` can start it.
 *
 * ```ts
 * export const fixIssue = workflow('fix-issue', IssueParameters, async ({ parameters }) => {
 * 	const issue = await github.collect(parameters.issue)
 * })
 * ```
 */
export const IssueParameters = Object.freeze({ issue: IssueRef })
export type IssueParameters = typeof IssueParameters

/** Where collected issues are dumped, for agents to read. */
const issuesFolder = workspace.folder('issues', { description: 'the issues this run works on, one Markdown file each' })

/** A collected issue: what GitHub has, and its Markdown dump in the workspace, which is how it appears in a prompt. */
export interface Issue extends IssueData {
	/** The dump, relative to the workspace. */
	readonly path: string
	/** The dump's absolute path, which is how it renders in a prompt. */
	[toPrompt](): string
}

/**
 * Collects an issue: reads it from GitHub and writes it as Markdown into `issues/` in the
 * workspace, with its repository, URL, author, state, labels and when it was made, then its body.
 * Collecting it again writes it again, as it is on GitHub by then. Runs on the host, through the
 * gateway, so the token never reaches the sandbox.
 *
 * A tool for agents and a function for code. In a prompt it renders as the Markdown file's absolute
 * path, so the agent reads as much of it as it needs, also after it changed directory into a
 * checkout ([design: Context](https://github.com/Marvin-Brouwer/code-workflow/blob/main/docs/design.md#context)).
 * In code, its fields are what GitHub has.
 *
 * Input: `{ repository, number }`, such as `{ repository: 'team/app', number: 12 }`.
 *
 * @throws When GitHub has no such issue, or the token can't read it, and when no token is set on the
 * host (`mesh-flow credential set github/token`).
 *
 * @example From code
 * ```ts
 * const issue = await github.collect(parameters.issue)
 * if (issue.state === 'closed') return
 * if (!issue.labels.includes('bug')) await github.label(issue, ['needs-triage'])
 * ```
 *
 * @example In a prompt
 * ```ts
 * const issue = await github.collect(parameters.issue)
 * await developer.loop`Fix ${issue} in ${repository}, then push with ${github.push(repository)} and ${succeed()}.`
 * ```
 */
export const collect = tool('githubCollect', {
	description: 'Reads a GitHub issue and writes it as Markdown into the workspace',
	input: IssueRef,
	action: async (ref, context): Promise<Issue> => {
		const data = await stubs.getIssue(ref, context)
		const file = workspace.file(`${issuesFolder.path}/${fileName(data)}`)
		await file.write(markdownOf(data))
		const location = file.location()
		return Object.freeze({ ...data, path: file.path, [toPrompt]: () => location })
	},
})

/**
 * Comments on an issue or a pull request, in Markdown. Every comment is signed with a footer that
 * names mesh-flow and the run. With a `key`, commenting again with the same key updates the earlier
 * comment instead of adding a new one, so a rerun, or a status that changes as the run goes on,
 * keeps one comment. Without one, every call adds a comment.
 *
 * @param on - The issue or pull request: anything with its `repository` and `number`, such as a
 * collected issue or an opened pull request.
 * @param body - The comment, in Markdown.
 * @param options - `key`: names the comment within the issue, such as `status`, so a later comment
 * with the same key replaces it.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The comment's id and its URL.
 * @throws When GitHub has no such issue, or the token may not comment on it.
 *
 * @example
 * ```ts
 * await github.comment(issue, 'Picked up: working on a fix.', { key: 'status' })
 * // ...
 * await github.comment(issue, `Fixed in ${pullRequest.url}`, { key: 'status' })
 * ```
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

/**
 * Adds labels to an issue or a pull request. Labels it already has stay as they are, and a label
 * the repository doesn't have yet is made.
 *
 * @param on - The issue or pull request: anything with its `repository` and `number`.
 * @param labels - The labels to add.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns Every label the issue has afterwards.
 * @throws When GitHub has no such issue, or the token may not label it.
 *
 * @example
 * ```ts
 * const labels = await github.label(issue, ['in-progress'])
 * ```
 */
export async function label(on: IssueRef, labels: readonly string[], context?: ToolContext): Promise<readonly string[]> {
	return (await stubs.labelIssue({ repository: on.repository, number: on.number, labels: [...labels] }, context)).labels
}

/**
 * Closes an issue. Closing a closed issue does nothing, so a rerun is safe.
 *
 * @param on - The issue: anything with its `repository` and `number`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @throws When GitHub has no such issue, or the token may not close it.
 *
 * @example
 * ```ts
 * const { state } = await github.review(pullRequest, handlers)
 * if (state === 'merged') await github.close(issue)
 * ```
 */
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
