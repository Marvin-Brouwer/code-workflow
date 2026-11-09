import { wait, type ToolContext, type WaitSpec } from '@mesh-flow/core'
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
	/** New review comments, reviews and conversation comments, coalesced per look, oldest first. The run's own are left out. */
	readonly comments?: (comments: readonly ReviewItem[]) => Promise<unknown>
	/** The checks of a commit came out failed. Once per commit. */
	readonly checksFailed?: (failed: ChecksFailed) => Promise<unknown>
}

/** Options of `review`. */
export interface ReviewOptions {
	/** How long to wait between looks. Default: 30 seconds. */
	readonly every?: WaitSpec
}

/** How a review ended. */
export interface ReviewOutcome {
	readonly state: 'merged' | 'closed'
	readonly pullRequest: PullRequest
}

const defaultEvery: WaitSpec = { seconds: 30 }

/**
 * Watches a pull request until it's merged or closed, and calls the handlers as things happen on
 * it: review comments come in one list per look, so a reviewer's round is one call, and failed
 * checks come once per commit. Handlers run one at a time. The wait between looks is on the
 * engine's clock, where the run can be paused.
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
	let since: string | undefined
	const reportedChecks = new Set<string>()
	for (;;) {
		const current = pullRequestOf(await stubs.getPullRequest(where, context))
		if (current.state === 'closed') return { state: current.merged ? 'merged' : 'closed', pullRequest: current }

		const activity = await stubs.reviewActivity({ ...where, ...(since === undefined ? {} : { since }) }, context)
		since = activity.until
		const comments = activity.items.filter((item) => item.author !== activity.self)
		if (comments.length > 0 && handlers.comments !== undefined) await handlers.comments(comments)

		if (handlers.checksFailed !== undefined && !reportedChecks.has(current.head.sha)) {
			const checks = await stubs.checksOnRef({ repository: on.repository, ref: current.head.sha }, context)
			if (checks.status === 'completed') {
				reportedChecks.add(current.head.sha)
				if (checks.failures.length > 0)
					await handlers.checksFailed({ pullRequest: current, sha: current.head.sha, failures: checks.failures })
			}
		}

		await wait(options.every ?? defaultEvery)
	}
}
