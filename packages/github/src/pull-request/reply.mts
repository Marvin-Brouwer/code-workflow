import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import type { PostedComment } from '../tools/issue-tools.mts'
import { ReviewItemId, type PullRequestRef } from '../tools/pull-request-tools.mts'

/**
 * The tool that replies to a review item on a pull request: in the thread of a comment on a line,
 * or on the conversation for a review or a comment there. The agent names the item by the id it
 * saw, such as `review-comment/12`.
 *
 * ```ts
 * await reviewer.loop`Handle ${comments} on ${pullRequest}. Reply to each with ${github.reply(pullRequest)}.`
 * ```
 */
export function reply(on: PullRequestRef): Tool<{ item: string; text: string }, PostedComment> {
	return tool('reply', {
		description: `Replies to a review item on pull request ${on.repository}#${String(on.number)}`,
		input: z.object({ item: ReviewItemId.describe('The id of the item, as listed'), text: z.string().min(1) }),
		action: ({ item, text }, context) =>
			stubs.replyToReviewItem({ repository: on.repository, number: on.number, item, body: text }, context),
	})
}
