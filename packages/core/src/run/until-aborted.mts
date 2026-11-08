/**
 * Waits for `promise`, or rejects with the signal's reason as soon as it aborts. The work behind the
 * promise goes on; this only stops waiting for it, so work that ignores its signal can't hold up a
 * stop.
 */
export async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	const { promise: aborted, reject } = Promise.withResolvers<never>()
	const onAbort = () => {
		reject(signal.reason)
	}
	signal.addEventListener('abort', onAbort, { once: true })
	try {
		return await Promise.race([promise, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

/** Waits at most `ms` for `promise`. Says whether it settled in time; a rejection counts as settled. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(resolve, ms, false)
	})
	try {
		return await Promise.race([
			promise.then(
				() => true as const,
				() => true as const,
			),
			timedOut,
		])
	} finally {
		clearTimeout(timer)
	}
}
