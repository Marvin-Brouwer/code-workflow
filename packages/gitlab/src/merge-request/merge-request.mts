import { toPrompt, type ToolContext } from '@mesh-flow/core'
import { decideOnEdit, type ChangeText } from '@mesh-flow/code-repository'
import { sameProjectPath } from '../project-path.mts'
import { push } from '../repository/push.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { MergeRequestData, MergeRequestRef, UpdateSkip } from '../tools/merge-request-tools.mts'
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
 * When the text was written from a merge request (`basedOn`), that one is updated with
 * `updateMergeRequest`, never a new one opened: it may have been merged or closed meanwhile, and
 * someone may have edited it, which the person is asked about first.
 *
 * ```ts
 * const mergeRequest = await gitlab.openMergeRequest(repository, await gitlab.describe(writer, repository, { closes: story }))
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
 * no. Resolves to the merge request as it is then, with `skipped` saying why when nothing was written.
 *
 * ```ts
 * await gitlab.updateMergeRequest(mergeRequest, await gitlab.describe(writer, repository, { closes: story, mergeRequest }))
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

/** Reads a merge request as it is now: its state, whether it was merged, and its head commit. */
export async function mergeRequest(ref: MergeRequestRef, context?: ToolContext): Promise<MergeRequest> {
	return mergeRequestOf(await stubs.getMergeRequest({ repository: ref.repository, number: ref.number }, context))
}

/** The open merge request of the checkout's branch onto the default branch, when it has one. */
export async function findOpenMergeRequest(repository: Repository, context?: ToolContext): Promise<MergeRequest | undefined> {
	const found = await stubs.findMergeRequest(
		{ repository: repository.name, head: repository.branch, base: repository.defaultBranch },
		context,
	)
	return found === null ? undefined : mergeRequestOf(found)
}

/** A merge request's data as the value code gets, which renders as its URL in a prompt. */
export function mergeRequestOf(data: MergeRequestData): MergeRequest {
	return Object.freeze({ ...data, [toPrompt]: () => data.url })
}
