import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestData, PullRequestRef } from '../tools/pull-request-tools.mts'
import { closingField } from './closing-reference.mts'
import type { PullRequestContent } from './pull-request-text.mts'

/** A pull request. In a prompt it renders as its URL. */
export interface PullRequest extends PullRequestData {
	[toPrompt](): string
}

/**
 * Commits and pushes what the checkout holds, then opens a pull request for its branch onto the
 * default branch. When the branch already has an open pull request, that one gets the title and
 * the description instead, so a rerun opens nothing twice. An open pull request whose description
 * was written for the same commit keeps it, as it was reviewed. The description is signed like
 * every post, and marked with the commit it describes, which `describe` reads to skip its loop.
 *
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
 * ```
 */
export async function openPullRequest(repository: Repository, content: PullRequestContent, context?: ToolContext): Promise<PullRequest> {
	const { head } = await push(repository)({ message: content.title }, context)
	const data = await stubs.openPullRequest(
		{
			repository: repository.name,
			head: repository.branch,
			base: repository.defaultBranch,
			title: content.title,
			body: content.description,
			describedSha: content.describedSha ?? head,
			...closingField(content.closes, repository.name),
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
 * await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
 * ```
 */
export async function updatePullRequest(
	ref: PullRequestRef,
	content: PullRequestContent,
	context?: ToolContext,
): Promise<UpdatedPullRequest> {
	const { skipped, ...data } = await stubs.updatePullRequest(
		{
			repository: ref.repository,
			number: ref.number,
			title: content.title,
			body: content.description,
			...(content.describedSha === undefined ? {} : { describedSha: content.describedSha }),
			...closingField(content.closes, ref.repository),
		},
		context,
	)
	return Object.freeze({ ...pullRequestOf(data), ...(skipped === undefined ? {} : { skipped }) })
}

/** Reads a pull request as it is now: its state, whether it was merged, and its head commit. */
export async function pullRequest(ref: PullRequestRef, context?: ToolContext): Promise<PullRequest> {
	return pullRequestOf(await stubs.getPullRequest({ repository: ref.repository, number: ref.number }, context))
}

/** A pull request's data as the value code gets, which renders as its URL in a prompt. */
export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
