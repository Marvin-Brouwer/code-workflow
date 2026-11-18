import { duration, sleep, type Duration } from '@mesh-flow/duration'
import { unavailable } from './http-statuses.mts'

/** How a request to a service is tried again when the connection drops or the service is briefly unavailable. */
export interface FetchRetryOptions {
	/** The wait before each retry, in order: a request is sent once more than there are waits. None sends it once. */
	readonly waits: readonly Duration[]
	/** The longest `retry-after` that is waited out. A longer one is handed back as it is, so the caller sees the rate limit. */
	readonly longestRetryAfter: Duration
	/** How long one attempt may wait for the answer before it counts as dropped. */
	readonly attemptTimeout: Duration
}

/**
 * Five attempts over about fifteen seconds: enough for a laptop to get its network back after
 * sleep, or for the service to answer again after a hiccup, without holding up a call for long. An
 * attempt that gets no answer in half a minute, on a connection that went quiet, counts as dropped.
 */
export const defaultFetchRetry: FetchRetryOptions = {
	waits: [duration.of('1s'), duration.of('2s'), duration.of('4s'), duration.of('8s')],
	longestRetryAfter: duration.of('1m'),
	attemptTimeout: duration.of('30s'),
}

/**
 * The methods that are sent again by default: reads. When a connection drops, a write may have
 * reached the service all the same, and sending it again would make a second comment, or fail on
 * what the first did.
 */
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** A request as {@link FetchResends} judges it, before it's sent. */
export interface OutgoingRequest {
	/** The method, in capitals. */
	readonly method: string
	/** Where the request goes, parsed, so a predicate can match on `pathname`. */
	readonly url: URL
}

/**
 * Whether a request may be sent again, for a service where more than reads can: an update that
 * sets a value, say, or a search sent as a POST. Default: reads only.
 */
export type FetchResends = (request: OutgoingRequest) => boolean

/** Whether `request` is a read, the requests every service may get twice. */
export const readsOnly: FetchResends = ({ method }) => readMethods.has(method)

/**
 * Wraps `send` so that the requests `resends` allows (reads by default) are sent again, after
 * each of the `waits` in turn, when the connection fails or goes quiet, or the service is unavailable
 * (500, 502, 503, 504 or 429). A `retry-after` header, in seconds or as a date, sets the wait when
 * there is one. An attempt that goes quiet fails as `fetch` does when undici's wait for the headers
 * runs out. The last answer or error is what the caller gets. Aborting the request's signal stops
 * the waiting at once. A `Request` object is sent as it is, once: its body can't be read twice.
 */
export function retryingFetch(send: typeof fetch, options: FetchRetryOptions, resends: FetchResends = readsOnly): typeof fetch {
	return async (input, init) => {
		if (input instanceof Request || !resendable(init?.body)) return send(input, init)
		const request = { method: (init?.method ?? 'GET').toUpperCase(), url: new URL(input) }
		if (!resends(request)) return send(input, init)
		const abortSignal = init?.signal ?? undefined

		for (const backoff of [...options.waits, undefined]) {
			let wait: Duration
			try {
				const response = await answeredWithin(options.attemptTimeout, abortSignal, (attemptAbortSignal) =>
					send(input, { ...init, signal: attemptAbortSignal }),
				)
				if (backoff === undefined || !unavailable(response.status)) return response
				const retryAt = retryAfterOf(response)
				if (retryAt !== undefined && retryAt > options.longestRetryAfter.after(new Date())) return response
				wait = retryAt === undefined ? backoff : untilThen(retryAt)
				await response.body?.cancel()
			} catch (error) {
				if (backoff === undefined || abortSignal?.aborted === true) throw error
				wait = backoff
			}
			await sleep(wait, abortSignal ?? neverAborted)
		}
		throw new Error('A retrying fetch ended without an answer, which the last attempt always gives.')
	}
}

/**
 * Sends with a signal that also aborts when no answer came within `timeout`. Only the wait for
 * the answer is timed: once it's in, the timer is cleared, so a slow body is read to the end, under
 * the caller's signal alone.
 */
async function answeredWithin(
	timeout: Duration,
	abortSignal: AbortSignal | undefined,
	sendWith: (attemptAbortSignal: AbortSignal) => Promise<Response>,
): Promise<Response> {
	const noAnswer = new AbortController()
	const timer = setTimeout(() => {
		noAnswer.abort(noAnswerError(timeout))
	}, timeout.to('ms'))
	try {
		return await sendWith(abortSignal === undefined ? noAnswer.signal : AbortSignal.any([abortSignal, noAnswer.signal]))
	} finally {
		clearTimeout(timer)
	}
}

/** Undici's code for an answer whose headers didn't come in time. */
const headersTimeoutCode = 'UND_ERR_HEADERS_TIMEOUT'

/**
 * The error a send rejects with when no answer came in time: the one `fetch` throws when undici's
 * own wait for the headers runs out, so a client that tells network failures apart by their code,
 * such as jira.js, counts it as one that may pass.
 */
function noAnswerError(timeout: Duration): TypeError {
	const cause = Object.assign(new Error(`The service didn't answer within ${timeout.toString()}.`), { code: headersTimeoutCode })
	return new TypeError('fetch failed', { cause })
}

/** A stream or form body is used up by the first send; no body or a string can be sent again. */
function resendable(body: RequestInit['body']): boolean {
	return body === undefined || body === null || typeof body === 'string'
}

/** When the `retry-after` header says to try again, from a number of seconds or a date. */
function retryAfterOf(response: Response): Date | undefined {
	const header = response.headers.get('retry-after')
	if (header === null || header.trim() === '') return undefined
	const seconds = Number(header)
	if (Number.isFinite(seconds)) return seconds >= 0 ? duration({ seconds }).after(new Date()) : undefined
	const at = new Date(header)
	return Number.isNaN(at.getTime()) ? undefined : at
}

/** The time from now until `at`, or none when it has passed. */
function untilThen(at: Date): Duration {
	const now = new Date()
	return at > now ? duration.between(now, at) : duration({})
}

/** For a request sent without a signal: nothing stops its waits. */
const neverAborted = new AbortController().signal
