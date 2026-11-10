import { check, durationMs, wait, type Check, type WaitSpec } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'
import { defaultLookEvery } from './look-interval.mts'

/** Options of `checksPass`. */
export interface ChecksPassOptions {
	/** How long to wait between looks while checks run. Default: 30 seconds. */
	readonly every?: WaitSpec
	/**
	 * How long to wait for the first check to appear on a fresh commit before taking a repository
	 * without checks for one where every check passed. Default: 10 minutes.
	 */
	readonly appearWithin?: WaitSpec
}

const defaultAppearWithin: WaitSpec = { minutes: 10 }

/** A zero interval still counts as one look. */
const atLeastOneLookMs = 1

/**
 * A check for `verify`: waits for the checks on the pull request's head commit to complete, and
 * reports each one that failed as a finding. Checks take a while to appear after a push, so a
 * commit without any is looked at again until `appearWithin` has passed.
 *
 * ```ts
 * await developer.loop`Fix the build, push with ${github.push(repository)} and hand in with ${verify(github.checksPass(pullRequest))}.`
 * ```
 */
export function checksPass(on: PullRequestRef, options: ChecksPassOptions = {}): Check {
	const every = options.every ?? defaultLookEvery
	const looksForChecksToAppear = Math.ceil(
		durationMs(options.appearWithin ?? defaultAppearWithin) / Math.max(durationMs(every), atLeastOneLookMs),
	)
	return check('checks', async (context) => {
		const where = { repository: on.repository, number: on.number }
		let looksWithoutChecks = 0
		for (;;) {
			const { head } = await stubs.getPullRequest(where, context)
			const checks = await stubs.checksOnRef({ repository: on.repository, ref: head.sha }, context)
			if (checks.status === 'none') looksWithoutChecks++
			const done = checks.status === 'completed' || (checks.status === 'none' && looksWithoutChecks > looksForChecksToAppear)
			if (done) {
				return checks.failures.map((failure) => ({
					source: `check: ${failure.name}`,
					message: failure.url === undefined ? failure.summary : `${failure.summary} (${failure.url})`,
				}))
			}
			await wait(every)
		}
	})
}
