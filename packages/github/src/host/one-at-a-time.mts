/** A call that waits its turn behind the earlier calls with the same key. */
export type OneAtATime = <T>(key: string, abortSignal: AbortSignal, call: () => Promise<T>) => Promise<T>

/**
 * Runs calls with the same key one after another, and calls with different keys side by side. A
 * call that fails doesn't stop the ones queued after it. A call whose `abortSignal` aborts while it
 * waits rejects at once with the signal's reason, and is never run.
 */
export function oneAtATime(): OneAtATime {
	const lastOn = new Map<string, Promise<unknown>>()
	return async (key, abortSignal, call) => {
		const turn = (lastOn.get(key) ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => {
				abortSignal.throwIfAborted()
				return call()
			})
		lastOn.set(key, turn)
		try {
			return await untilAborted(turn, abortSignal)
		} finally {
			if (lastOn.get(key) === turn) lastOn.delete(key)
		}
	}
}

/** `work`, or a rejection with the signal's reason as soon as `abortSignal` aborts. */
function untilAborted<T>(work: Promise<T>, abortSignal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortSignal.reason)
		}
		if (abortSignal.aborted) onAbort()
		abortSignal.addEventListener('abort', onAbort, { once: true })
		work.then(
			(value) => {
				abortSignal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				abortSignal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}
