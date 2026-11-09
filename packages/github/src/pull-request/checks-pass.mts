import { check, wait, type Check, type WaitSpec } from '@mesh-flow/core'
import { stubs } from '../stubs.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'

/** Options of `checksPass`. */
export interface ChecksPassOptions {
	/** How long to wait between looks while checks run. Default: 30 seconds. */
	readonly every?: WaitSpec
}

const defaultEvery: WaitSpec = { seconds: 30 }

/**
 * A check for `verify`: waits for the checks on the pull request's head commit to complete, and
 * reports each one that failed as a finding.
 *
 * ```ts
 * await developer.loop`Fix the build, push with ${github.push(repository)} and hand in with ${verify(github.checksPass(pullRequest))}.`
 * ```
 */
export function checksPass(on: PullRequestRef, options: ChecksPassOptions = {}): Check {
	return check('checks', async (context) => {
		const where = { repository: on.repository, number: on.number }
		for (;;) {
			const { head } = await stubs.getPullRequest(where, context)
			const checks = await stubs.checksOnRef({ repository: on.repository, ref: head.sha }, context)
			if (checks.status === 'completed') {
				return checks.failures.map((failure) => ({
					source: `check: ${failure.name}`,
					message: failure.url === undefined ? failure.summary : `${failure.summary} (${failure.url})`,
				}))
			}
			await wait(options.every ?? defaultEvery)
		}
	})
}
