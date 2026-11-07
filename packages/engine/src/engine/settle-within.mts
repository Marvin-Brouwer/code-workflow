/**
 * Waits until `work` settles or `signal` aborts, whichever comes first, and never rejects. For
 * shutdown: work that ignores its signal can't hold the engine up past a deadline.
 */
export function settleWithin(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
	return untilAborted(work, signal).then(
		() => undefined,
		() => undefined,
	)
}

/**
 * Settles with `work`, or rejects with the signal's reason once `signal` aborts. For calls that
 * take a signal but might not honour it in time, such as a pause on shutdown.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(reasonOf(signal))
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			reject(reasonOf(signal))
		}
		signal.addEventListener('abort', abort, { once: true })
		work.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

function reasonOf(signal: AbortSignal): Error {
	const reason: unknown = signal.reason
	return reason instanceof Error ? reason : new Error(String(reason))
}
