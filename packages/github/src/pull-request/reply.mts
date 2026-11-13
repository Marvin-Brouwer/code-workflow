import { tool, type Tool } from '@mesh-flow/core'
import { ReplyStage } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type PullRequestRef, type ReplyOutcome } from '../tools/pull-request-tools.mts'

/** What the agent replies with: the item, the text, and whether it's a plan or the answer. */
export interface ReplyInput {
	readonly item: string
	readonly text: string
	readonly stage?: ReplyStage | undefined
}

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
	return tool('reply', {
		description: `Replies to a review item on pull request ${on.repository}#${String(on.number)}`,
		input: z.object({
			item: ReviewItemId.describe('The id of the item, as listed'),
			text: z.string().min(1),
			stage: ReplyStage.optional().describe(
				'plan: what you will do about the item, before you change anything. answer (the default): the answer to a question, or what you did.',
			),
		}),
		action: ({ item, text, stage }, context) =>
			stubs.replyToReviewItem(
				{ repository: on.repository, number: on.number, item, body: text, ...(stage === undefined ? {} : { stage }) },
				context,
			),
	})
}
