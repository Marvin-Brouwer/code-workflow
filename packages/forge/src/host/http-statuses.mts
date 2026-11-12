/**
 * Answers that say a service couldn't serve the request just now, rather than that it was wrong.
 * Octokit reports a dropped connection as 500 too.
 */
const unavailableStatuses = new Set([500, 502, 503, 504])

/** The answer to too many requests. */
const tooManyRequests = 429

/** Whether a service couldn't serve the request just now: a 5xx that may pass, or a rate limit. */
export function unavailable(status: number): boolean {
	return status === tooManyRequests || unavailableStatuses.has(status)
}
