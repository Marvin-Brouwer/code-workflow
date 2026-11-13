import { branchHeadOf, untilCompleted } from '@mesh-flow/code-repository'
import { check, type Check, type WaitSpec } from '@mesh-flow/core'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'

/** Options of `checksPass`. */
export interface ChecksPassOptions {
	/** How long to wait between looks while checks run. Default: 10 seconds. */
	readonly every?: WaitSpec
	/**
	 * How long to wait for the first check to appear on a fresh commit before taking a repository
	 * without checks for one where every check passed. Default: 10 minutes.
	 */
	readonly appearWithin?: WaitSpec
	/**
	 * How long looks at GitHub may keep failing, say while the network is down, before the check
	 * fails with the last error. Counted in looks, as in `review`. Default: 10 minutes.
	 */
	readonly toleratedOutage?: WaitSpec
	/**
	 * The checkout whose branch the pull request is of. With it, the commit looked at is the one last
	 * pushed from it, rather than the head GitHub shows, which can lag a few seconds behind a push: a
	 * check right after a push then waits for that commit's checks instead of reporting the last one's.
	 */
	readonly checkout?: Repository
}

/**
 * A check for `verify`: waits for the checks on the pull request's head commit to complete, and
 * reports each one that failed as a finding. Checks take a while to appear after a push, so a
 * commit without any is looked at again until `appearWithin` has passed. A look that fails is tried
 * again on the next one, for up to `toleratedOutage`.
 *
 * ```ts
 * await developer.loop`Fix the build, push with ${github.push(repository)} and hand in with ${verify(github.checksPass(pullRequest, { checkout: repository }))}.`
 * ```
 */
export function checksPass(on: PullRequestRef, options: ChecksPassOptions = {}): Check {
	return check('checks', async (context) => {
		const where = { repository: on.repository, number: on.number }
		const failures = await untilCompleted(async () => {
			const sha =
				options.checkout === undefined
					? (await stubs.getPullRequest(where, context)).head.sha
					: await branchHeadOf(options.checkout, true, context)
			return stubs.checksOnRef({ repository: on.repository, ref: sha }, context)
		}, options)
		return failures.map((failure) => ({
			source: `check: ${failure.name}`,
			message: failure.url === undefined ? failure.summary : `${failure.summary} (${failure.url})`,
		}))
	})
}
