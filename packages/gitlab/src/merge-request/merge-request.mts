import { decideOnEdit, type UpdateSkip, type ChangeText } from '@mesh-flow/code-repository'
import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { sameProjectPath } from '../project-path.mts'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { MergeRequestData, MergeRequestRef } from '../tools/merge-request-tools.mts'
import { closingField } from './closing-reference.mts'
import type { MergeRequestContent } from './merge-request-text.mts'

/** A merge request, which renders as its URL in a prompt. */
export interface MergeRequest extends MergeRequestData {
	[toPrompt](): string
}

/**
 * Commits and pushes what the checkout holds, then opens a merge request for its branch onto the
 * default branch. When the branch already has an open merge request, that one gets the title and
 * the description instead, so a rerun opens nothing twice. An open merge request whose description
 * was written for the same commit keeps it, as it was reviewed. The description is signed like
 * every post, and marked with the commit it describes, which `describe` reads to skip its loop.
 *
 * When the text was written from a merge request (`basedOn`), that one is updated with
 * `updateMergeRequest`, never a new one opened: it may have been merged or closed meanwhile, and
 * someone may have edited it, which the person is asked about first.
 *
 * The content usually comes from `gitlab.describe`, but code can write it too: `title` and
 * `description` are all it needs, and `closes` puts `Fixes <key>` in the footer. Text without
 * `basedOn` replaces what an open merge request of the branch has, also an edit a person made.
 *
 * @param repository - The checkout whose branch to open the merge request for, from `gitlab.checkout`.
 * @param content - The title and description, and optionally the issue it closes.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The merge request, which renders as its URL in a prompt.
 * @throws When the branch has no commits on top of the default branch; when the branch already has
 * an open merge request onto another target branch, such as after a reviewer changed its target;
 * and when GitLab turns the push or the merge request down.
 *
 * @example With a description an agent wrote
 * ```ts
 * const mergeRequest = await gitlab.openMergeRequest(repository, await gitlab.describe(writer, repository, { issue: story }))
 * ```
 *
 * @example With a description of your own
 * ```ts
 * const mergeRequest = await gitlab.openMergeRequest(repository, {
 * 	title: `Update packages for ${story.key}`,
 * 	description: 'Updates every NuGet package to its latest minor version.',
 * 	closes: story,
 * })
 * await jira.comment(story, `Opened ${mergeRequest.url}`, { key: `mr-${repository.name}` })
 * ```
 */
export async function openMergeRequest(repository: Repository, content: MergeRequestContent, context?: ToolContext): Promise<MergeRequest> {
	const { basedOn } = content
	if (basedOn !== undefined) {
		const ref = { repository: basedOn.repository, number: basedOn.number }
		// Merged or closed meanwhile: nothing to push to, and its text stays.
		const current = await mergeRequest(ref, context)
		if (current.state === 'closed') return current
		await push(repository)({ message: content.title }, context)
		return updateMergeRequest(ref, content, context)
	}
	const { head } = await push(repository)({ message: content.title }, context)
	const data = await stubs.openMergeRequest(
		{
			repository: repository.name,
			head: repository.branch,
			base: repository.defaultBranch,
			title: content.title,
			body: content.description,
			describedSha: content.describedSha ?? head,
			...closingField(content.closes),
		},
		context,
	)
	return mergeRequestOf(data)
}

/** A merge request after `updateMergeRequest`, with why nothing was written when nothing was. */
export interface UpdatedMergeRequest extends MergeRequest {
	/** Why nothing was written, when nothing was: see {@link UpdateSkip}. */
	readonly skipped?: UpdateSkip
}

/**
 * Gives a merge request a new title and description, such as `describe` wrote them after a round of
 * review. Nothing is written when the merge request already says this, or when it's closed: a
 * merged merge request keeps the text it was reviewed with. When someone edited it after `describe`
 * read it, the person is asked whether to overwrite the edit, and nothing is written when they say
 * no. Pushes nothing: push first when the text describes new commits.
 *
 * @param ref - The merge request: anything with its `repository` and `number`, such as one
 * `openMergeRequest` gave.
 * @param content - The new title and description, and optionally the issue it closes. Text written
 * from another merge request than `ref` is refused.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The merge request as it is then, with `skipped` saying why when nothing was written:
 * `unchanged` when it already said this, `closed` when it's closed, and `edited` when the person kept
 * someone's edit.
 * @throws When `content` was written from another merge request, and when GitLab has no such
 * merge request.
 *
 * @example After a round of review
 * ```ts
 * await gitlab.updateMergeRequest(mergeRequest, await gitlab.describe(writer, repository, { issue: story, mergeRequest }))
 * ```
 *
 * @example A title of your own
 * ```ts
 * const updated = await gitlab.updateMergeRequest({ repository: 'team/api', number: 7 }, { title: 'Draft: Update packages', description })
 * if (updated.skipped === 'closed') return
 * ```
 */
export async function updateMergeRequest(
	ref: MergeRequestRef,
	content: MergeRequestContent,
	context?: ToolContext,
): Promise<UpdatedMergeRequest> {
	const { basedOn } = content
	if (basedOn !== undefined && (!sameProjectPath(basedOn.repository, ref.repository) || basedOn.number !== ref.number))
		throw new Error(
			`The text was written from ${basedOn.repository}!${String(basedOn.number)}, not from ${ref.repository}!${String(ref.number)}.`,
		)
	let lastSeen: ChangeText | undefined = basedOn
	for (;;) {
		const decision = await decideOnEdit(() => mergeRequest(ref, context), content, lastSeen)
		if ('kept' in decision) return Object.freeze({ ...decision.kept, skipped: 'edited' as const })
		const { skipped, ...data } = await stubs.updateMergeRequest(
			{
				repository: ref.repository,
				number: ref.number,
				title: content.title,
				body: content.description,
				...(content.describedSha === undefined ? {} : { describedSha: content.describedSha }),
				...closingField(content.closes),
				...(decision.seen === undefined ? {} : { seen: decision.seen }),
			},
			context,
		)
		// Edited between the last look and the write: look again, which asks the person.
		if (skipped !== 'edited') return Object.freeze({ ...mergeRequestOf(data), ...(skipped === undefined ? {} : { skipped }) })
		lastSeen = decision.seen
	}
}

/**
 * Reads a merge request as it is now: its title, description, state, whether it was merged and
 * with which commit, and its head commit and branch.
 *
 * @param ref - The merge request: anything with its `repository` and `number`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The merge request, which renders as its URL in a prompt.
 * @throws When GitLab has no such merge request, or the token can't read it.
 *
 * @example
 * ```ts
 * const current = await gitlab.mergeRequest({ repository: 'team/api', number: 7 })
 * if (current.merged) await jira.transition(story, 'Done')
 * ```
 */
export async function mergeRequest(ref: MergeRequestRef, context?: ToolContext): Promise<MergeRequest> {
	return mergeRequestOf(await stubs.getMergeRequest({ repository: ref.repository, number: ref.number }, context))
}

/** The open merge request of the checkout's branch onto the default branch, when it has one. */
export async function findOpenMergeRequest(repository: Repository, context?: ToolContext): Promise<MergeRequest | undefined> {
	return branchMergeRequest(repository, 'opened', context)
}

/**
 * The merge request this run opened that merged the checkout's branch into the default branch, when
 * there is one; the latest, when there are several. A run that starts over after a repository was
 * delivered, such as one whose sandbox was lost, finds it here, while the branch may be gone or hold
 * nothing new. A merge of the branch by an earlier run or by a person isn't this run's, and isn't
 * found.
 *
 * @param repository - The checkout whose branch to look for, from `gitlab.checkout`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The merge request, or `undefined` when no merge request this run opened for the branch
 * was merged.
 *
 * @example Deliver each repository once, also across a rerun
 * ```ts
 * const mergeRequest = (await gitlab.mergedMergeRequest(repository)) ?? (await deliver(repository))
 * ```
 */
export async function mergedMergeRequest(repository: Repository, context?: ToolContext): Promise<MergeRequest | undefined> {
	return branchMergeRequest(repository, 'merged', context)
}

/** The checkout's branch's merge request onto the default branch in `state`, when it has one. */
async function branchMergeRequest(
	repository: Repository,
	state: 'opened' | 'merged',
	context?: ToolContext,
): Promise<MergeRequest | undefined> {
	const found = await stubs.findMergeRequest(
		{ repository: repository.name, head: repository.branch, base: repository.defaultBranch, state },
		context,
	)
	return found === null ? undefined : mergeRequestOf(found)
}

/** A merge request's data as the value code gets, which renders as its URL in a prompt. */
export function mergeRequestOf(data: MergeRequestData): MergeRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
