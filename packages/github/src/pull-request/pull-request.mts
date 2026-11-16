import { decideOnEdit, type UpdateSkip } from '@mesh-flow/code-repository'
import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { sameRepositoryName } from '../repository-name.mts'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestData, PullRequestRef } from '../tools/pull-request-tools.mts'
import { closingField } from './closing-reference.mts'
import type { PullRequestContent, PullRequestText } from './pull-request-text.mts'

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
 * The content usually comes from `github.describe`, but code can write it too: `title` and
 * `description` are all it needs, and `closes` puts `Fixes #7` in the footer (`Fixes owner/name#7`
 * for an issue in another repository).
 *
 * @param repository - The checkout whose branch to open the pull request for, from `github.checkout`.
 * @param content - The title and description, and optionally the issue it closes.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The pull request, which renders as its URL in a prompt.
 * @throws When the branch has no commits on top of the default branch, and when GitHub turns the
 * push or the pull request down.
 *
 * @example With a description an agent wrote
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
 * ```
 *
 * @example With a description of your own
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, {
 * 	title: `Fix #${String(issue.number)}: ${issue.title}`,
 * 	description: 'Keeps the session cookie when Safari blocks third-party cookies.',
 * 	closes: issue,
 * })
 * await github.comment(issue, `Opened ${pullRequest.url}`, { key: 'status' })
 * ```
 */
export async function openPullRequest(repository: Repository, content: PullRequestContent, context?: ToolContext): Promise<PullRequest> {
	const { basedOn } = content
	if (basedOn !== undefined) {
		const ref = { repository: basedOn.repository, number: basedOn.number }
		// Merged or closed meanwhile: nothing to push to, and its text stays.
		const current = await pullRequest(ref, context)
		if (current.state === 'closed') return current
		const pushed = await push(repository)({ message: content.title }, context)
		return updatePullRequest(ref, { ...content, describedSha: content.describedSha ?? pushed.head }, context)
	}
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
	/** Why nothing was written, when nothing was: see {@link UpdateSkip}. */
	readonly skipped?: UpdateSkip
}

/**
 * Gives a pull request a new title and description, such as `describe` wrote them after a round of
 * review. Nothing is written when the pull request already says this, or when it's closed: a merged
 * pull request keeps the text it was reviewed with. When someone edited it after `describe` read
 * it, the person is asked whether to overwrite the edit, and nothing is written when they say no.
 * Resolves to the pull request as it is then, with `skipped` saying why when nothing was written.
 *
 * Pushes nothing: push first when the text describes new commits.
 *
 * @param ref - The pull request: anything with its `repository` and `number`, such as one
 * `openPullRequest` gave.
 * @param content - The new title and description, and optionally the issue it closes. Text written
 * from another pull request than `ref` is refused. Leaving out `closes` takes an existing `Fixes`
 * line out, and text without `describedSha`, such as code wrote, has the next `describe` write the
 * text again.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The pull request as it is then, with `skipped` saying why when nothing was written:
 * `unchanged` when it already said this, `closed` when it's closed, and `edited` when the person
 * kept someone's edit.
 * @throws When `content` was written from another pull request, and when GitHub has no such pull
 * request.
 *
 * @example After a round of review
 * ```ts
 * await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
 * ```
 *
 * @example A title of your own
 * ```ts
 * const ref = { repository: 'team/app', number: 42 }
 * const current = await github.pullRequest(ref)
 * const updated = await github.updatePullRequest(ref, {
 * 	title: 'Fix the login on Safari',
 * 	description: current.description,
 * 	closes: issue,
 * })
 * if (updated.skipped === 'closed') return
 * ```
 */
export async function updatePullRequest(
	ref: PullRequestRef,
	content: PullRequestContent,
	context?: ToolContext,
): Promise<UpdatedPullRequest> {
	const { basedOn } = content
	if (basedOn !== undefined && (!sameRepositoryName(basedOn.repository, ref.repository) || basedOn.number !== ref.number))
		throw new Error(
			`The text was written from ${basedOn.repository}#${String(basedOn.number)}, not from ${ref.repository}#${String(ref.number)}.`,
		)
	let lastSeen: PullRequestText | undefined = basedOn
	for (;;) {
		const decision = await decideOnEdit(() => pullRequest(ref, context), content, lastSeen)
		if ('kept' in decision) return Object.freeze({ ...decision.kept, skipped: 'edited' as const })
		const { skipped, ...data } = await stubs.updatePullRequest(
			{
				repository: ref.repository,
				number: ref.number,
				title: content.title,
				body: content.description,
				...(content.describedSha === undefined ? {} : { describedSha: content.describedSha }),
				...closingField(content.closes, ref.repository),
				...(decision.seen === undefined ? {} : { seen: decision.seen }),
			},
			context,
		)
		// Edited between the last look and the write: look again, which asks the person.
		if (skipped !== 'edited') return Object.freeze({ ...pullRequestOf(data), ...(skipped === undefined ? {} : { skipped }) })
		lastSeen = decision.seen
	}
}

/**
 * Reads a pull request as it is now: its title, description, state, whether it was merged, and its
 * head commit and branch.
 *
 * @param ref - The pull request: anything with its `repository` and `number`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The pull request, which renders as its URL in a prompt.
 * @throws When GitHub has no such pull request, or the token can't read it.
 *
 * @example
 * ```ts
 * const current = await github.pullRequest({ repository: 'team/app', number: 42 })
 * if (current.merged) await github.close(issue)
 * ```
 */
export async function pullRequest(ref: PullRequestRef, context?: ToolContext): Promise<PullRequest> {
	return pullRequestOf(await stubs.getPullRequest({ repository: ref.repository, number: ref.number }, context))
}

/** The open pull request of the checkout's branch onto the default branch, when it has one. */
export async function findOpenPullRequest(repository: Repository, context?: ToolContext): Promise<PullRequest | undefined> {
	return branchPullRequest(repository, 'open', context)
}

/**
 * The pull request this run opened that merged the checkout's branch into the default branch, when
 * there is one; the latest, when there are several. A run that starts over after it delivered, such
 * as one whose sandbox was lost while it waited for the review, finds it here, while the branch may
 * be gone or hold nothing new. A merge of the branch by an earlier run or by a person isn't this
 * run's, and isn't found.
 *
 * @param repository - The checkout whose branch to look for, from `github.checkout`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The pull request, or `undefined` when no pull request this run opened for the branch was
 * merged.
 * @throws When GitHub has no such repository, or the token can't read it.
 *
 * @example Deliver once, also across a rerun
 * ```ts
 * const merged = await github.mergedPullRequest(repository)
 * if (merged !== undefined) {
 * 	await github.close(issue)
 * 	return
 * }
 * ```
 */
export async function mergedPullRequest(repository: Repository, context?: ToolContext): Promise<PullRequest | undefined> {
	return branchPullRequest(repository, 'merged', context)
}

/** The checkout's branch's pull request onto the default branch in `state`, when it has one. */
async function branchPullRequest(
	repository: Repository,
	state: 'open' | 'merged',
	context?: ToolContext,
): Promise<PullRequest | undefined> {
	const found = await stubs.findPullRequest(
		{ repository: repository.name, head: repository.branch, base: repository.defaultBranch, state },
		context,
	)
	return found === null ? undefined : pullRequestOf(found)
}

/** A pull request's data as the value code gets, which renders as its URL in a prompt. */
export function pullRequestOf(data: PullRequestData): PullRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
