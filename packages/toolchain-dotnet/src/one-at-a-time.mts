import { untilAborted } from '@mesh-flow/core'

/** A call that waits its turn behind the earlier calls with the same key. */
export type OneAtATime = <T>(key: string, abortSignal: AbortSignal, call: () => Promise<T>) => Promise<T>

/**
 * Runs calls with the same key one after another, and calls with different keys side by side. A
 * call that fails doesn't stop the ones queued after it. A call whose `abortSignal` aborts while it
 * waits rejects at once with the signal's reason, and is never run; one that runs is waited for,
 * since it settles on its own once its signal aborts. `@mesh-flow/gateway` has one for the host's
 * tools, which stops waiting for a running call too; this package runs in the sandbox.
 */
export function oneAtATime(): OneAtATime {
	const lastOn = new Map<string, Promise<unknown>>()
	return async (key, abortSignal, call) => {
		const before = (lastOn.get(key) ?? Promise.resolve()).catch(() => undefined)
		const { promise: done, resolve } = Promise.withResolvers<undefined>()
		// The next call waits for the one before this too, should this one stop while it waits.
		const turn = before.then(() => done)
		lastOn.set(key, turn)
		void turn.finally(() => {
			if (lastOn.get(key) === turn) lastOn.delete(key)
		})
		try {
			await untilAborted(before, abortSignal)
			return await call()
		} finally {
			resolve(undefined)
		}
	}
}
