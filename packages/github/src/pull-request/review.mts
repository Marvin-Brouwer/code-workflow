import { wait, type ToolContext, type WaitSpec } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import type { CheckFailure, PullRequestRef, ReviewItem } from '../tools/pull-request-tools.mts'
import { defaultLookEvery, defaultToleratedOutage } from '@mesh-flow/forge'
import { patientLook } from '@mesh-flow/forge'
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
	const every = options.every ?? defaultLookEvery
	const look = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	let since: string | undefined
	// The host lists from the latest moment seen, inclusive, so an item at that second comes again.
	const handled = new Set<string>()
	const reportedChecks = new Set<string>()
	for (;;) {
		const current = pullRequestOf(await look(() => stubs.getPullRequest(where, context)))
		if (current.state === 'closed') return { state: current.merged ? 'merged' : 'closed', pullRequest: current }

		const activity = await look(() => stubs.reviewActivity({ ...where, ...(since === undefined ? {} : { since }) }, context))
		since = activity.until ?? since
		const comments = activity.items.filter((item) => !handled.has(item.id))
		for (const item of comments) handled.add(item.id)
		if (comments.length > 0 && handlers.comments !== undefined) {
			const items = comments.map((item) => ({
				id: item.id,
				url: item.url,
				...(item.inReplyTo === undefined ? {} : { thread: item.inReplyTo }),
			}))
			const { answered } = await look(() => stubs.showBeingRead({ ...where, items }, context))
			// Answered before the run started over: the reviewer has the answer already, and writes a new comment if it doesn't settle it.
			const unanswered = comments.filter((item) => !answered.includes(item.id))
			if (unanswered.length > 0) await handlers.comments(unanswered)
		}

		if (handlers.checksFailed !== undefined && !reportedChecks.has(current.head.sha)) {
			const checks = await look(() => stubs.checksOnRef({ repository: on.repository, ref: current.head.sha }, context))
			if (checks.status === 'completed') {
				reportedChecks.add(current.head.sha)
				if (checks.failures.length > 0)
					await handlers.checksFailed({ pullRequest: current, sha: current.head.sha, failures: checks.failures })
			}
		}

		await wait(every)
	}
}
