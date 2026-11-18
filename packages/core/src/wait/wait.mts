import type { Duration } from '@mesh-flow/duration'
import { waitingOnHuman } from '../loop/loop-clock.mts'
import { inEvent } from '../run/run-events.mts'

/**
 * Waits for `time`, on the engine's clock. Timers inside a sandbox don't agree across a pause, so
 * the engine keeps the time and wakes the run; a wait is where a run can be paused. Use it to poll
 * something outside, such as a pull request, between host tool calls.
 *
 * ```ts
 * const lookEvery = duration.of('30s')
 * for (;;) {
 * 	const pullRequest = await github.pullRequest(opened)
 * 	if (pullRequest.merged) break
 * 	await wait(lookEvery)
 * }
 * ```
 *
 * Inside a loop, as from a check that waits for a pipeline, the wait doesn't count toward the
 * loop's `limit`.
 */
export async function wait(time: Duration): Promise<void> {
	await inEvent('wait', { time: time.toString() }, async (scope) => {
		const id = `wake-${scope.run.count('wake')}`
		const at = time.after(new Date()).toISOString()
		scope.run.channel.send({ type: 'request', request: { kind: 'wake', id, at } })
		await waitingOnHuman(() => scope.run.channel.answer(id, scope.run.abortSignal))
	})
}
