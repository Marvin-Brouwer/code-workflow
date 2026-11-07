/**
 * Settles with `work`, or rejects with the signal's reason as soon as `signal` aborts.
 *
 * For SDK calls that take no signal: the work itself can't be stopped and keeps going. When it
 * finishes after the abort, its value goes to `discard`, so a sandbox that was created too late
 * can still be removed instead of leaking.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, discard?: (late: T) => Promise<unknown>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(abortReason(signal))
			work
				.then(
					(late) => discard?.(late),
					() => undefined,
				)
				.catch(() => undefined)
		}
		if (signal.aborted) {
			onAbort()
			return
		}
		signal.addEventListener('abort', onAbort, { once: true })
		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}

/** The reason an aborted signal carries, which is always set, as an `Error` to reject with. */
function abortReason(signal: AbortSignal): Error {
	const reason: unknown = signal.reason
	return reason instanceof Error ? reason : new Error(String(reason))
}
