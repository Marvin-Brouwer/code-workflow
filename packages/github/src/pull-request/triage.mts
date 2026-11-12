import type { Agent, Limit } from '@mesh-flow/core'
import {
	triageItems,
	triageResult as forgeTriageResult,
	type PlannedChange as ForgePlannedChange,
	type TriageForge,
} from '@mesh-flow/forge'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import { githubTerms } from './github-terms.mts'
import { isGoneReply, ReviewItemId, type PullRequestRef, type ReviewItem } from '../tools/pull-request-tools.mts'

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
export type PlannedChange = ForgePlannedChange<ReviewItem>

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
 * ```ts
 * const changes = await github.triage(developer, repository, { pullRequest, comments })
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
function githubTriage(pullRequest: PullRequestRef): TriageForge<ReviewItem> {
	return {
		terms: githubTerms,
		itemId: ReviewItemId,
		reply: async (item, body, stage) => ({
			gone: isGoneReply(await stubs.replyToReviewItem({ ...pullRequest, item: item.id, body, stage })),
		}),
	}
}

/** What the agent finishes with: every item in `comments`, once, with what it asks for and its reply. */
export function triageResult(comments: readonly ReviewItem[]) {
	return forgeTriageResult(comments, ReviewItemId)
}
