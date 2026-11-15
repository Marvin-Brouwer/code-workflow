import { isGoneReply, triageItems, type PlannedChange as SharedPlannedChange, type TriageCodeHost } from '@mesh-flow/code-repository'
import type { Agent, Limit } from '@mesh-flow/core'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type PullRequestRef, type ReviewItem } from '../tools/pull-request-tools.mts'
import { githubTerms } from './github-terms.mts'

/** What `triage` takes besides the agent and the checkout. */
export interface TriageOptions {
	/** The pull request the items are on. */
	readonly pullRequest: PullRequestRef
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
 * answer say what was done. So the reviewer sees each item go from being read, to the plan, to what
 * was done, and a question go from being read to its answer.
 *
 * Code posts the replies, not the agent, once the loop is done. A line comment deleted since it was
 * read is left out. Stopping the run stops the loop and any reply still in flight.
 *
 * @param agent - The agent that sorts the items: the workflow's own, as the package ships none.
 * @param repository - The checkout of the pull request's branch, which the agent reads to answer.
 * @param options - The pull request, the items `review` handed over, and the loop's limit.
 * @returns The items that ask for a change, each with the agent's plan for it. Empty when every
 * item was a question or a change the agent won't make, which got its answer already.
 * @throws When the loop fails or runs out of its limit.
 *
 * @example Sorting a round of review
 * ```ts
 * const changes = await github.triage(developer, repository, { pullRequest, comments })
 * ```
 *
 * @example Making the changes
 * ```ts
 * await github.review(pullRequest, {
 * 	comments: async (comments) => {
 * 		const changes = await github.triage(developer, repository, { pullRequest, comments })
 * 		for (const change of changes)
 * 			await developer.loop`
 * 				Make ${change.plan} in ${repository}, push with ${github.push(repository)},
 * 				and reply to ${change.item.id} with ${github.reply(pullRequest)}.
 * 			`
 * 	},
 * })
 * ```
 */
export function triage(agent: Agent, repository: Repository, options: TriageOptions): Promise<readonly PlannedChange[]> {
	const { pullRequest, comments } = options
	return triageItems(agent, repository, githubTriage(pullRequest), {
		request: pullRequest,
		comments,
		...(options.limit === undefined ? {} : { limit: options.limit }),
	})
}

/** How `triage` replies on GitHub. */
function githubTriage(pullRequest: PullRequestRef): TriageCodeHost<ReviewItem> {
	return {
		terms: githubTerms,
		itemId: ReviewItemId,
		reply: async (item, body, stage) => ({
			gone: isGoneReply(await stubs.replyToReviewItem({ ...pullRequest, item: item.id, body, stage })),
		}),
	}
}
