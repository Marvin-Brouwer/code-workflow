import type { Scope } from '../run/run-scope.mts'

/** How a loop ends. The first one wins. */
export type LoopOutcome = { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'error'; readonly error: unknown }

/**
 * When the agent's run has to stop: `round` lets the current tool round finish (an exit was called,
 * or a tool threw), `now` stops it at once (the run was stopped, a limit ran out).
 */
export type Stop = 'round' | 'now'

/** What a loop's tools share with the loop that runs them. */
export interface LoopSession {
	/** The loop's scope: events of its tool calls go under the loop's event. */
	readonly scope: Scope
	/** Aborted when the loop has to stop at once. Tools pass it to their actions. */
	readonly abortSignal: AbortSignal
	/** Ends the loop. Only the first call counts. */
	finish(outcome: LoopOutcome, stop: Stop): void
}
