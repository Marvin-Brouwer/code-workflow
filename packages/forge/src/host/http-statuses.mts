/** Answers that say a service couldn't serve the request just now, rather than that it was wrong. */
const unavailableStatuses = new Set([500, 502, 503, 504])

/** The answer to too many requests. */
const tooManyRequests = 429

/** The answer to a request without a valid token. */
export const unauthorized = 401

/** The answer for what isn't there, or never was. */
export const notFound = 404

/** The answer for what was there and was deleted since. */
export const goneStatus = 410

/** Whether a service couldn't serve the request just now: a 5xx that may pass, or a rate limit. */
export function unavailable(status: number): boolean {
	return status === tooManyRequests || unavailableStatuses.has(status)
}
