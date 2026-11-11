import { setTimeout as sleep } from 'node:timers/promises'

/** How a request to GitHub is tried again when the connection drops or GitHub is briefly unavailable. */
export interface FetchRetryOptions {
	/** How many times a request is sent at most, the first time included. */
	readonly attempts: number
	/** The wait before the first retry; every next one waits twice as long. */
	readonly firstDelayMs: number
	/** The longest `retry-after` that is waited out. A longer one is handed back as it is, so the caller sees the rate limit. */
	readonly longestRetryAfterMs: number
}

/**
 * Five attempts over about fifteen seconds: enough for a laptop to get its network back after
 * sleep, or for GitHub to answer again after a hiccup, without holding up a call for long.
 */
export const defaultFetchRetry: FetchRetryOptions = { attempts: 5, firstDelayMs: 1000, longestRetryAfterMs: 60_000 }

/**
 * The methods that may be sent twice: when a connection drops, the request may have reached GitHub
 * all the same, and a second POST would make a second comment or pull request.
 */
const idempotentMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])

/** Answers that say GitHub couldn't serve the request just now, rather than that the request was wrong. */
const unavailableStatuses = new Set([500, 502, 503, 504])

/** GitHub's answer to too many requests. */
const tooManyRequests = 429

/** `retry-after` counts in seconds. */
const msPerSecond = 1000

/**
 * Wraps `send` so that idempotent requests are sent again, with a doubling wait in between, when
 * the connection fails or GitHub answers 5xx or 429. A `retry-after` header sets the wait when there
 * is one. The last answer or error is what the caller gets. Aborting the request's signal stops the
 * waiting at once.
 */
export function retryingFetch(send: typeof fetch, options: FetchRetryOptions): typeof fetch {
	return async (input, init) => {
		if (!idempotent(init)) return send(input, init)
		const abortSignal = init?.signal ?? undefined

		for (let attempt = 1; ; attempt++) {
			const lastAttempt = attempt >= options.attempts
			const backoffMs = options.firstDelayMs * 2 ** (attempt - 1)
			let delayMs: number
			try {
				const response = await send(input, init)
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

/** Whether a request may be sent again: its method is idempotent and its body can be sent twice. */
function idempotent(init: RequestInit | undefined): boolean {
	return idempotentMethods.has((init?.method ?? 'GET').toUpperCase()) && resendable(init?.body)
}

/** A stream or form body is used up by the first send; no body or a string can be sent again. */
function resendable(body: RequestInit['body']): boolean {
	return body === undefined || body === null || typeof body === 'string'
}

/** Whether GitHub couldn't serve the request just now: a 5xx or a rate limit. */
function unavailable(status: number): boolean {
	return status === tooManyRequests || unavailableStatuses.has(status)
}

/** The `retry-after` header in milliseconds, when it holds a number of seconds. */
function retryAfterOf(response: Response): number | undefined {
	const header = response.headers.get('retry-after')
	if (header === null) return undefined
	const seconds = Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * msPerSecond : undefined
}
