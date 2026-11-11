import { toPrompt, type ToolContext } from '@mesh-flow/core'
import type { IssueRef } from '../issue/issue.mts'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestData, PullRequestRef } from '../tools/pull-request-tools.mts'

/** A pull request. In a prompt it renders as its URL. */
export interface PullRequest extends PullRequestData {
	[toPrompt](): string
}

/** What `openPullRequest` takes: the text, such as `describe` writes it, and the issue it closes. */
export interface OpenPullRequestOptions {
	readonly title: string
	readonly description: string
	/** The issue the pull request closes when it merges: a `Fixes` line goes under the description. */
	readonly closes?: IssueRef
}

/**
 * Commits and pushes what the checkout holds, then opens a pull request for its branch onto the
 * default branch. When the branch already has an open pull request, that one gets the title and
 * the description instead, so a rerun opens nothing twice. The description is signed like every
 * post, and marked with the commit it describes, which `redescribe` reads.
 *
 * ```ts
 * const text = await github.describe(writer, repository, { issue })
 * const pullRequest = await github.openPullRequest(repository, { ...text, closes: issue })
 * ```
 */
export async function openPullRequest(
	repository: Repository,
	options: OpenPullRequestOptions,
	context?: ToolContext,
): Promise<PullRequest> {
	const { head } = await push(repository)({ message: options.title }, context)
	const body = withClosingReference(options.description, options.closes, repository.name)
	const data = await stubs.openPullRequest(
		{
			repository: repository.name,
			head: repository.branch,
			base: repository.defaultBranch,
			title: options.title,
			body,
			described: head,
		},
		context,
	)
	return pullRequestOf(data)
}

/** `description` with the line that has GitHub close `issue` when the pull request in `repository` merges. */
export function withClosingReference(description: string, issue: IssueRef | undefined, repository: string): string {
	if (issue === undefined) return description
	const ref = issue.repository === repository ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
	return `${description}\n\nFixes ${ref}`
}

/** Reads a pull request as it is now: its state, whether it was merged, and its head commit. */
export async function pullRequest(ref: PullRequestRef, context?: ToolContext): Promise<PullRequest> {
	return pullRequestOf(await stubs.getPullRequest({ repository: ref.repository, number: ref.number }, context))
}

export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
