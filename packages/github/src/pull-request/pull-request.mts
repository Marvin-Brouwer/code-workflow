import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestData, PullRequestRef } from '../tools/pull-request-tools.mts'

/** A pull request. In a prompt it renders as its URL. */
export interface PullRequest extends PullRequestData {
	[toPrompt](): string
}

/** What `openPullRequest` takes. */
export interface OpenPullRequestOptions {
	readonly title: string
	readonly description: string
}

/**
 * Commits and pushes what the checkout holds, then opens a pull request for its branch onto the
 * default branch. When the branch already has an open pull request, that one is returned, so a
 * rerun opens nothing twice.
 *
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, { title: issue.title, description: `Fixes #${String(issue.number)}` })
 * ```
 */
export async function openPullRequest(
	repository: Repository,
	options: OpenPullRequestOptions,
	context?: ToolContext,
): Promise<PullRequest> {
	await push(repository)({ message: options.title }, context)
	const data = await stubs.openPullRequest(
		{
			repository: repository.name,
			head: repository.branch,
			base: repository.defaultBranch,
			title: options.title,
			body: options.description,
		},
		context,
	)
	return pullRequestOf(data)
}

/** Reads a pull request as it is now: its state, whether it was merged, and its head commit. */
export async function pullRequest(ref: PullRequestRef, context?: ToolContext): Promise<PullRequest> {
	return pullRequestOf(await stubs.getPullRequest({ repository: ref.repository, number: ref.number }, context))
}

export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
