import { replyTool, type ReplyInput } from '@mesh-flow/code-repository'
import type { Tool } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type MergeRequestRef, type ReplyOutcome } from '../tools/merge-request-tools.mts'

/**
 * The tool that replies to a review item on a merge request, in the item's thread. The agent names
 * the item by the id it saw, such as `note/12`.
 *
 * With `stage: 'plan'` the reply says what will be done, in place of the "👀 Reading..." reply. The
 * answer that follows, what was done, is then a reply of its own, so the reviewer is notified of it.
 * A question needs no plan: its answer replaces the reading reply right away. A note deleted since
 * it was read comes back as `{ gone: true }`.
 *
 * ```ts
 * await developer.loop`Make ${change.plan} in ${repository}, push, and reply with ${gitlab.reply(mergeRequest)}.`
 * ```
 */
export function reply(on: MergeRequestRef): Tool<ReplyInput, ReplyOutcome> {
	return replyTool({
		on: `merge request ${on.repository}!${String(on.number)}`,
		item: ReviewItemId,
		replyToReviewItem: (answer, context) => stubs.replyToReviewItem({ repository: on.repository, number: on.number, ...answer }, context),
	})
}
