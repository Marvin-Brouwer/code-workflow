/** A call that waits its turn behind the earlier calls with the same key. */
export type OneAtATime = <T>(key: string, abortSignal: AbortSignal, call: () => Promise<T>) => Promise<T>

/**
 * Runs calls with the same key one after another, and calls with different keys side by side. A
 * call that fails doesn't stop the ones queued after it. A call whose `abortSignal` aborts while it
 * waits rejects at once with the signal's reason, and is never run; one that runs is waited for,
 * since it settles on its own once its signal aborts. Like `packages/github`'s host helper: core
 * doesn't export one.
 */
export function oneAtATime(): OneAtATime {
	const lastOn = new Map<string, Promise<unknown>>()
	return async (key, abortSignal, call) => {
		const before = (lastOn.get(key) ?? Promise.resolve()).catch(() => undefined)
		const { promise: done, resolve } = Promise.withResolvers<undefined>()
		// The next call waits for the one before this too, should this one stop while it waits.
		const turn = before.then(async () => done)
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

/** Waits for `promise`, or rejects with the signal's reason as soon as it aborts. */
async function untilAborted<T>(promise: Promise<T>, abortSignal: AbortSignal): Promise<T> {
	abortSignal.throwIfAborted()
	const { promise: aborted, reject } = Promise.withResolvers<never>()
	const onAbort = () => {
		reject(abortSignal.reason)
	}
	abortSignal.addEventListener('abort', onAbort, { once: true })
	try {
		return await Promise.race([promise, aborted])
	} finally {
		abortSignal.removeEventListener('abort', onAbort)
	}
}
