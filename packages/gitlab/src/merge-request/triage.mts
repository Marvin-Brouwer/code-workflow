import { isGoneReply, triageItems, type PlannedChange as SharedPlannedChange, type TriageCodeHost } from '@mesh-flow/code-repository'
import type { Agent, Limit } from '@mesh-flow/core'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type MergeRequestRef, type ReviewItem } from '../tools/merge-request-tools.mts'
import { gitlabTerms } from './gitlab-terms.mts'

/** What `triage` takes besides the agent and the checkout. */
export interface TriageOptions {
	/** The merge request the items are on. */
	readonly mergeRequest: MergeRequestRef
	/** The items to sort, as `review` hands them to its `comments` handler. */
	readonly comments: readonly ReviewItem[]
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/** An item that asks for a change, and what the agent said it will do about it. */
export type PlannedChange = SharedPlannedChange<ReviewItem>

/**
 * Has `agent` sort review items into questions and requests for a change, in one loop that changes
 * nothing. A question, and a change the agent won't make, get the answer as the reply, in place of
 * the "👀 Reading..." reply. A request for a change gets a plan as the reply, what the agent will do
 * about it, and comes back to the caller, which has the work done in a loop of its own and has its
 * answer say what was done, with `gitlab.reply`.
 *
 * Code posts the replies, not the agent, once the loop is done. A note deleted since it was read is
 * left out. Stopping the run stops the loop and any reply still in flight.
 *
 * @param agent - The agent that sorts the items: the workflow's own, as the package ships none.
 * @param repository - The checkout of the merge request's branch, which the agent reads to answer.
 * @param options - The merge request, the items `review` handed over, and the loop's limit.
 * @returns The items that ask for a change, each with the agent's plan for it. Empty when every
 * item was a question or a change the agent won't make, which got its answer already.
 * @throws When the loop fails or runs out of its limit; and, with the stop's reason, when the run stops.
 *
 * @example In a review
 * ```ts
 * await gitlab.review(mergeRequest, {
 * 	comments: async (comments) => {
 * 		const changes = await gitlab.triage(developer, repository, { mergeRequest, comments })
 * 		for (const change of changes)
 * 			await developer.loop`
 * 				Make ${change.plan} in ${repository}, push with ${gitlab.push(repository)},
 * 				and reply to ${change.item.id} with ${gitlab.reply(mergeRequest)}.
 * 			`
 * 	},
 * })
 * ```
 */
export function triage(agent: Agent, repository: Repository, options: TriageOptions): Promise<readonly PlannedChange[]> {
	const { mergeRequest, comments } = options
	return triageItems(agent, repository, gitlabTriage(mergeRequest), {
		request: mergeRequest,
		comments,
		...(options.limit === undefined ? {} : { limit: options.limit }),
	})
}

/** How `triage` replies on GitLab. */
function gitlabTriage(mergeRequest: MergeRequestRef): TriageCodeHost<ReviewItem> {
	return {
		terms: gitlabTerms,
		itemId: ReviewItemId,
		reply: async (item, body, stage) => ({
			gone: isGoneReply(
				await stubs.replyToReviewItem({ repository: mergeRequest.repository, number: mergeRequest.number, item: item.id, body, stage }),
			),
		}),
	}
}
