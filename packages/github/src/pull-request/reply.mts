import { replyTool, type ReplyInput } from '@mesh-flow/code-repository'
import type { Tool } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type PullRequestRef, type ReplyOutcome } from '../tools/pull-request-tools.mts'

/**
 * The tool that replies to a review item on a pull request: in the thread of a comment on a line,
 * or on the conversation for a review or a comment there. The agent names the item by the id it
 * saw, such as `review-comment/12`.
 *
 * With `stage: 'plan'` the reply says what will be done, in place of the "👀 Reading..." reply. The
 * answer that follows, what was done, is then a reply of its own, so the reviewer is notified of it.
 * A question needs no plan: its answer replaces the reading reply right away. A line comment deleted
 * since it was read comes back as `{ gone: true }`.
 *
 * ```ts
 * await reviewer.loop`Handle ${comments} on ${pullRequest}. Reply to each with ${github.reply(pullRequest)}.`
 * ```
 */
export function reply(on: PullRequestRef): Tool<ReplyInput, ReplyOutcome> {
	return replyTool({
		on: `pull request ${on.repository}#${String(on.number)}`,
		item: ReviewItemId,
		replyToReviewItem: (answer, context) => stubs.replyToReviewItem({ repository: on.repository, number: on.number, ...answer }, context),
	})
}
