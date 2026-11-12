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

/** What `openPullRequest` and `updatePullRequest` take: the text, such as `describe` writes it, and the issue it closes. */
export interface PullRequestTextOptions {
	readonly title: string
	readonly description: string
	/** The commit the description was written for; `describe` sets it. Default for `openPullRequest`: the pushed head. */
	readonly describes?: string
	/** The issue the pull request closes when it merges: a `Fixes` line goes in the footer. */
	readonly closes?: IssueRef
}

/**
 * Commits and pushes what the checkout holds, then opens a pull request for its branch onto the
 * default branch. When the branch already has an open pull request, that one gets the title and
 * the description instead, so a rerun opens nothing twice. The description is signed like every
 * post, and marked with the commit it describes, which `describe` reads to skip its loop.
 *
 * ```ts
 * const text = await github.describe(writer, repository, { issue })
 * const pullRequest = await github.openPullRequest(repository, { ...text, closes: issue })
 * ```
 */
export async function openPullRequest(
	repository: Repository,
	options: PullRequestTextOptions,
	context?: ToolContext,
): Promise<PullRequest> {
	const { head } = await push(repository)({ message: options.title }, context)
	const data = await stubs.openPullRequest(
		{
			repository: repository.name,
			head: repository.branch,
			base: repository.defaultBranch,
			title: options.title,
			body: options.description,
			described: options.describes ?? head,
			...closing(options.closes, repository.name),
		},
		context,
	)
	return pullRequestOf(data)
}

/** A pull request after `updatePullRequest`, with why nothing was written when nothing was. */
export interface UpdatedPullRequest extends PullRequest {
	/** `closed`: a closed pull request keeps its text. `unchanged`: it already said this. */
	readonly skipped?: 'closed' | 'unchanged'
}

/**
 * Gives a pull request a new title and description, such as `describe` wrote them after a round of
 * review. Nothing is written when the pull request already says this, or when it's closed: a merged
 * pull request keeps the text it was reviewed with. Resolves to the pull request as it is then,
 * with `skipped` saying why when nothing was written.
 *
 * ```ts
 * await github.updatePullRequest(pullRequest, { ...(await github.describe(writer, repository, { issue, pullRequest })), closes: issue })
 * ```
 */
export async function updatePullRequest(
	ref: PullRequestRef,
	options: PullRequestTextOptions,
	context?: ToolContext,
): Promise<UpdatedPullRequest> {
	const { skipped, ...data } = await stubs.updatePullRequest(
		{
			repository: ref.repository,
			number: ref.number,
			title: options.title,
			body: options.description,
			...(options.describes === undefined ? {} : { described: options.describes }),
			...closing(options.closes, ref.repository),
		},
		context,
	)
	return Object.freeze({ ...pullRequestOf(data), ...(skipped === undefined ? {} : { skipped }) })
}

/** How a pull request in `repository` names `issue` to close it: `#7` in the same repository, `owner/name#7` in another. */
export function closingReference(issue: IssueRef, repository: string): string {
	return issue.repository === repository ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
}

function closing(issue: IssueRef | undefined, repository: string): { closes?: string } {
	return issue === undefined ? {} : { closes: closingReference(issue, repository) }
}

/** Reads a pull request as it is now: its state, whether it was merged, and its head commit. */
export async function pullRequest(ref: PullRequestRef, context?: ToolContext): Promise<PullRequest> {
	return pullRequestOf(await stubs.getPullRequest({ repository: ref.repository, number: ref.number }, context))
}

export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
