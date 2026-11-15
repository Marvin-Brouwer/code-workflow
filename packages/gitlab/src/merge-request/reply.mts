import { replyTool, type ReplyInput } from '@mesh-flow/code-repository'
import type { Tool } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type MergeRequestRef, type ReplyOutcome } from '../tools/merge-request-tools.mts'

/**
 * The tool that replies to a review item on a merge request, in the item's thread, for an agent
 * that made a change a reviewer asked for, and for code. The item is named by the id `review`
 * handed over, such as `note/12`.
 *
 * With `stage: 'plan'` the reply says what will be done, in place of the "👀 Reading..." reply. The
 * answer that follows, what was done, is then a reply of its own, so the reviewer is notified of it.
 * A question needs no plan: its answer replaces the reading reply right away. Every reply is signed
 * like every post.
 *
 * @param on - The merge request the items are on: anything with its `repository` and `number`.
 * @returns The tool. Its input is `{ item, text, stage? }`: the item's id, the reply in Markdown,
 * and `plan` or `answer` (the default). It resolves to the posted reply, or to `{ gone: true }` when
 * the note was deleted since it was read.
 *
 * @example From code
 * ```ts
 * await gitlab.reply(mergeRequest)({ item: comment.id, text: 'Renamed in the next push.' })
 * ```
 *
 * @example For an agent
 * ```ts
 * for (const change of changes)
 * 	await developer.loop`Make ${change.plan} in ${repository}, push with ${gitlab.push(repository)}, and reply to ${change.item.id} with ${gitlab.reply(mergeRequest)}.`
 * ```
 */
export function reply(on: MergeRequestRef): Tool<ReplyInput, ReplyOutcome> {
	return replyTool({
		on: `merge request ${on.repository}!${String(on.number)}`,
		item: ReviewItemId,
		replyToReviewItem: (answer, context) => stubs.replyToReviewItem({ repository: on.repository, number: on.number, ...answer }, context),
	})
}
