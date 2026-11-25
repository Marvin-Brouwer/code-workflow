import { inEvent } from '../run/run-events.mts'

/**
 * One look of a poll: the calls that read something outside, such as a pull request's state, or
 * the wait before the next look. In the run's events it is a `poll` event around them, which the
 * run view folds with the polls next to it into one waiting bar, until something else happens.
 * What a poll finds and acts on runs outside it, so that shows as it happens.
 *
 * ```ts
 * const description = `merge of ${String(pullRequest.number)}`
 * for (;;) {
 * 	const current = await poll(description, () => github.pullRequest(pullRequest))
 * 	if (current.merged) break
 * 	await poll(description, () => wait(lookEvery))
 * }
 * ```
 *
 * @param description - What is waited for, such as `review of owner/name#12`: the waiting bar's title.
 * @param body - The look, or the wait.
 * @returns What `body` resolves to.
 */
export async function poll<Result>(description: string, body: () => Promise<Result>): Promise<Result> {
	return inEvent('poll', { description }, body)
}
