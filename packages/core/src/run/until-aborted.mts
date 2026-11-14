/**
 * Waits for `promise`, or rejects with the signal's reason as soon as it aborts. The work behind the
 * promise goes on; this only stops waiting for it, so work that ignores its signal can't hold up a
 * stop. For packages that run in the sandbox; `@mesh-flow/gateway` has its own for the host.
 */
export async function untilAborted<T>(promise: Promise<T>, abortSignal: AbortSignal): Promise<T> {
	// Nobody waits for the work any more: its own failure, such as the stop it saw too, is no rejection to report.
	promise.catch(() => undefined)
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
