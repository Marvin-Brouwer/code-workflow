import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestData, PullRequestRef } from '../tools/pull-request-tools.mts'
import { closingField } from './closing-reference.mts'
import { keptEdit } from './kept-edit.mts'
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
 * When the text was written from a pull request (`basedOn`), that one is updated with
 * `updatePullRequest`, never a new one opened: it may have been merged or closed meanwhile, and
 * someone may have edited it, which the person is asked about first.
 *
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
 * ```
 */
export async function openPullRequest(repository: Repository, content: PullRequestContent, context?: ToolContext): Promise<PullRequest> {
	const { head } = await push(repository)({ message: content.title }, context)
	const { basedOn } = content
	if (basedOn !== undefined) {
		return updatePullRequest(
			{ repository: repository.name, number: basedOn.number },
			{ ...content, describedSha: content.describedSha ?? head },
			context,
		)
	}
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
	/**
	 * `closed`: a closed pull request keeps its text. `unchanged`: it already said this. `edited`:
	 * someone edited it after `describe` read it, and the person chose to keep the edit.
	 */
	readonly skipped?: 'closed' | 'unchanged' | 'edited'
}

/**
 * Gives a pull request a new title and description, such as `describe` wrote them after a round of
 * review. Nothing is written when the pull request already says this, or when it's closed: a merged
 * pull request keeps the text it was reviewed with. When someone edited it after `describe` read
 * it, the person is asked whether to overwrite the edit, and nothing is written when they say no.
 * Resolves to the pull request as it is then, with `skipped` saying why when nothing was written.
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
	if (content.basedOn !== undefined && content.basedOn.number !== ref.number)
		throw new Error(`The text was written from pull request ${String(content.basedOn.number)}, not from ${String(ref.number)}.`)
	const kept = await keptEdit(() => pullRequest(ref, context), content)
	if (kept !== undefined) return Object.freeze({ ...kept, skipped: 'edited' as const })
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

/** The open pull request of the checkout's branch onto the default branch, when it has one. */
export async function findOpenPullRequest(repository: Repository, context?: ToolContext): Promise<PullRequest | undefined> {
	const found = await stubs.findPullRequest(
		{ repository: repository.name, head: repository.branch, base: repository.defaultBranch },
		context,
	)
	return found === null ? undefined : pullRequestOf(found)
}

/** A pull request's data as the value code gets, which renders as its URL in a prompt. */
export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
