import { waitingOnHuman } from '../loop/loop-clock.mts'
import { inEvent } from '../run/run-events.mts'

/** How long to wait. One of the fields; several add up. */
export interface WaitSpec {
	readonly seconds?: number
	readonly minutes?: number
	readonly hours?: number
}

const secondMs = 1_000
const minuteMs = 60 * secondMs
const hourMs = 60 * minuteMs

/**
 * Waits for a while, on the engine's clock. Timers inside a sandbox don't agree across a pause, so
 * the engine keeps the time and wakes the run; a wait is where a run can be paused. Use it to poll
 * something outside, such as a pull request, between host tool calls.
 *
 * ```ts
 * for (;;) {
 * 	const pullRequest = await github.pullRequest(opened)
 * 	if (pullRequest.merged) break
 * 	await wait({ seconds: 30 })
 * }
 * ```
 *
 * Inside a loop, as from a check that waits for a pipeline, the wait doesn't count toward the
 * loop's `limit`.
 */
export async function wait(spec: WaitSpec): Promise<void> {
	const ms = durationMs(spec)
	await inEvent('wait', { ms }, async (scope) => {
		const id = `wake-${scope.run.count('wake')}`
		const at = new Date(Date.now() + ms).toISOString()
		scope.run.channel.send({ type: 'request', request: { kind: 'wake', id, at } })
		await waitingOnHuman(() => scope.run.channel.answer(id, scope.run.abortSignal))
	})
}

/** The duration of a spec in milliseconds. Throws when it isn't a finite, non-negative duration. */
export function durationMs(spec: WaitSpec): number {
	const ms = (spec.seconds ?? 0) * secondMs + (spec.minutes ?? 0) * minuteMs + (spec.hours ?? 0) * hourMs
	if (!Number.isFinite(ms) || ms < 0) throw new Error(`A wait takes a non-negative duration, not ${JSON.stringify(spec)}.`)
	return ms
}
