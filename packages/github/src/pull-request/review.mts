import type { ToolContext, WaitSpec } from '@mesh-flow/core'
import { watchReview } from '@mesh-flow/forge'
import { stubs } from '../stubs.mts'
import type { CheckFailure, PullRequestRef, ReviewItem } from '../tools/pull-request-tools.mts'
import { pullRequestOf, type PullRequest } from './pull-request.mts'

/** The checks of one commit failed. */
export interface ChecksFailed {
	readonly pullRequest: PullRequest
	readonly sha: string
	readonly failures: readonly CheckFailure[]
}

/** What `review` calls as a pull request's review goes on. Each handler finishes before the next event is looked at. */
export interface ReviewHandlers {
	/**
	 * New review comments, reviews and conversation comments, coalesced per look, oldest first. What
	 * the run posted itself is left out. Before the handler is called, each item gets 👀 on GitHub:
	 * a reaction where GitHub takes one, and a "👀 Reading..." reply.
	 */
	readonly comments?: (comments: readonly ReviewItem[]) => Promise<unknown>
	/** The checks of a commit came out failed. Once per commit. */
	readonly checksFailed?: (failed: ChecksFailed) => Promise<unknown>
}

/** Options of `review`. */
export interface ReviewOptions {
	/** How long to wait between looks. Default: 10 seconds. */
	readonly every?: WaitSpec
	/**
	 * How long looks at GitHub may keep failing, say while the network is down, before `review`
	 * gives up with the last error. Counted in looks, `toleratedOutage / every` of them, so the time
	 * the failing calls take comes on top. Only failures that may pass count; a bad token or a missing
	 * permission fails at once. Default: 10 minutes.
	 */
	readonly toleratedOutage?: WaitSpec
}

/** How a review ended. */
export interface ReviewOutcome {
	readonly state: 'merged' | 'closed'
	readonly pullRequest: PullRequest
}

/**
 * Watches a pull request until it's merged or closed, and calls the handlers as things happen on
 * it: review comments come in one list per look, so a reviewer's round is one call, and failed
 * checks come once per commit, once its checks have all completed. An item handed to the handler
 * gets 👀 on GitHub first, so the reviewer sees it is being read: a reaction where GitHub takes
 * one, and a "👀 Reading..." reply that the first answer to the item replaces, taking the reaction
 * off again. Handlers run one at a time. The wait between looks is on the engine's clock, where the
 * run can be paused. A look that fails is tried again on the next one, for up to `toleratedOutage`,
 * so a watch that takes days outlives a dropped connection.
 *
 * ```ts
 * await github.review(pullRequest, {
 * 	comments: (comments) => reviewer.loop`
 * 		Handle these review comments on ${pullRequest}: ${comments}.
 * 		Change the code where a comment asks for it, push with ${github.push(repository)},
 * 		and reply to every comment with ${github.reply(pullRequest)}. When every comment is handled, ${succeed()}.
 * 	`,
 * })
 * ```
 */
export async function review(
	on: PullRequestRef,
	handlers: ReviewHandlers,
	options: ReviewOptions = {},
	context?: ToolContext,
): Promise<ReviewOutcome> {
	const where = { repository: on.repository, number: on.number }
	const { checksFailed } = handlers
	const { state, request } = await watchReview<PullRequest, ReviewItem, CheckFailure>(
		{
			read: async () => pullRequestOf(await stubs.getPullRequest(where, context)),
			activity: (since) => stubs.reviewActivity({ ...where, ...(since === undefined ? {} : { since }) }, context),
			showBeingRead: (items) =>
				stubs.showBeingRead(
					{
						...where,
						items: items.map((item) => ({
							id: item.id,
							url: item.url,
							...(item.inReplyTo === undefined ? {} : { thread: item.inReplyTo }),
						})),
					},
					context,
				),
			checks: (sha) => stubs.checksOnRef({ repository: on.repository, ref: sha }, context),
		},
		{
			...(handlers.comments === undefined ? {} : { comments: handlers.comments }),
			...(checksFailed === undefined ? {} : { failed: (pullRequest, sha, failures) => checksFailed({ pullRequest, sha, failures }) }),
		},
		options,
	)
	return { state, pullRequest: request }
}
