import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import { ReplyStage, ReviewItemId, type MergeRequestRef, type ReplyOutcome } from '../tools/merge-request-tools.mts'

/** What the agent replies with: the item, the text, and whether it's a plan or the answer. */
export interface ReplyInput {
	readonly item: string
	readonly text: string
	readonly stage?: ReplyStage | undefined
}

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
	return tool('reply', {
		description: `Replies to a review item on merge request ${on.repository}!${String(on.number)}`,
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
