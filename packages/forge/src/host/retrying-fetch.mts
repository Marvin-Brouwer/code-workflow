import { setTimeout as sleep } from 'node:timers/promises'
import { unavailable } from './http-statuses.mts'

/** How a request to a forge is tried again when the connection drops or the service is briefly unavailable. */
export interface FetchRetryOptions {
	/** How many times a request is sent at most, the first time included. */
	readonly attempts: number
	/** The wait before the first retry; every next one waits twice as long. */
	readonly firstDelayMs: number
	/** The longest `retry-after` that is waited out. A longer one is handed back as it is, so the caller sees the rate limit. */
	readonly longestRetryAfterMs: number
	/** How long one attempt may wait for the answer before it counts as dropped. */
	readonly attemptTimeoutMs: number
}

/**
 * Five attempts over about fifteen seconds: enough for a laptop to get its network back after
 * sleep, or for the service to answer again after a hiccup, without holding up a call for long. An
 * attempt that gets no answer in half a minute, on a connection that went quiet, counts as dropped.
 */
export const defaultFetchRetry: FetchRetryOptions = {
	attempts: 5,
	firstDelayMs: 1000,
	longestRetryAfterMs: 60_000,
	attemptTimeoutMs: 30_000,
}

/**
 * The methods that are sent again: reads. When a connection drops, a write may have reached the service
 * all the same, and sending it again would make a second comment, or fail on what the first did.
 */
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `retry-after` counts in seconds. */
const msPerSecond = 1000

/**
 * Wraps `send` so that reads are sent again, with a doubling wait in between, when the connection
 * fails or goes quiet, or the service answers 5xx or 429. A `retry-after` header sets the wait when there
 * is one. The last answer or error is what the caller gets. Aborting the request's signal stops the
 * waiting at once. A `Request` object is sent as it is, once: its body can't be read twice.
 */
export function retryingFetch(send: typeof fetch, options: FetchRetryOptions): typeof fetch {
	return async (input, init) => {
		if (input instanceof Request || !readOnly(init)) return send(input, init)
		const abortSignal = init?.signal ?? undefined

		for (let attempt = 1; ; attempt++) {
			const lastAttempt = attempt >= options.attempts
			const backoffMs = options.firstDelayMs * 2 ** (attempt - 1)
			let delayMs: number
			try {
				const response = await answeredWithin(options.attemptTimeoutMs, abortSignal, (attemptAbortSignal) =>
					send(input, { ...init, signal: attemptAbortSignal }),
				)
				if (lastAttempt || !unavailable(response.status)) return response
				const retryAfterMs = retryAfterOf(response)
				if (retryAfterMs !== undefined && retryAfterMs > options.longestRetryAfterMs) return response
				delayMs = retryAfterMs ?? backoffMs
				await response.body?.cancel()
			} catch (error) {
				if (lastAttempt || abortSignal?.aborted === true) throw error
				delayMs = backoffMs
			}
			await sleep(delayMs, undefined, abortSignal === undefined ? {} : { signal: abortSignal })
		}
	}
}

/**
 * Sends with a signal that also aborts when no answer came within `timeoutMs`. Only the wait for
 * the answer is timed: once it's in, the timer is cleared, so a slow body is read to the end, under
 * the caller's signal alone.
 */
async function answeredWithin(
	timeoutMs: number,
	abortSignal: AbortSignal | undefined,
	sendWith: (attemptAbortSignal: AbortSignal) => Promise<Response>,
): Promise<Response> {
	const noAnswer = new AbortController()
	const timer = setTimeout(() => {
		noAnswer.abort(new DOMException(`The service didn't answer within ${String(timeoutMs)} ms.`, 'TimeoutError'))
	}, timeoutMs)
	try {
		return await sendWith(abortSignal === undefined ? noAnswer.signal : AbortSignal.any([abortSignal, noAnswer.signal]))
	} finally {
		clearTimeout(timer)
	}
}

/** Whether a request may be sent again: it's a read, and its body, if any, can be sent twice. */
function readOnly(init: RequestInit | undefined): boolean {
	return readMethods.has((init?.method ?? 'GET').toUpperCase()) && resendable(init?.body)
}

/** A stream or form body is used up by the first send; no body or a string can be sent again. */
function resendable(body: RequestInit['body']): boolean {
	return body === undefined || body === null || typeof body === 'string'
}

/** The `retry-after` header in milliseconds, when it holds a number of seconds. */
function retryAfterOf(response: Response): number | undefined {
	const header = response.headers.get('retry-after')
	if (header === null) return undefined
	const seconds = Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * msPerSecond : undefined
}
