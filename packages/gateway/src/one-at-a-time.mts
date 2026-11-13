import { untilAborted } from './until-aborted.mts'

/** A call that waits its turn behind the earlier calls with the same key. */
export type OneAtATime = <T>(key: string, abortSignal: AbortSignal, call: () => Promise<T>) => Promise<T>

/**
 * Runs calls with the same key one after another, and calls with different keys side by side. A
 * call that fails doesn't stop the ones queued after it. A call whose `abortSignal` aborts while it
 * waits rejects at once with the signal's reason, and is never run.
 */
export function oneAtATime(): OneAtATime {
	const lastOn = new Map<string, Promise<unknown>>()
	return (key, abortSignal, call) => {
		const turn = (lastOn.get(key) ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => {
				abortSignal.throwIfAborted()
				return call()
			})
		lastOn.set(key, turn)
		// Forgotten once the turn is over, not when its caller stops waiting: the call before it may still run.
		void turn
			.catch(() => undefined)
			.finally(() => {
				if (lastOn.get(key) === turn) lastOn.delete(key)
			})
		return untilAborted(turn, abortSignal)
	}
}
