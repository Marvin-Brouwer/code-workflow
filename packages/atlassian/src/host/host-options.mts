/**
 * How Jira and Confluence requests are sent again when the site didn't answer, or answered 502, 503
 * or 504. Reads and updates are; requests that make something new, a comment or a transition, are
 * sent once.
 */
export interface RequestRetry {
	/** Sends of one request at most, the first one included. */
	readonly maxAttempts: number
	/** The wait before the first retry; each next wait is `backoffFactor` times as long. */
	readonly initialDelayMs: number
	/** How many times as long each wait is as the one before. */
	readonly backoffFactor: number
}

/** A request is sent up to four times, 500 ms after the first send, then a second, then two. */
export const defaultRequestRetry: RequestRetry = Object.freeze({ maxAttempts: 4, initialDelayMs: 500, backoffFactor: 2 })

/**
 * No retry: for a request that makes something, such as a comment, which a retry after a lost
 * answer would make twice, and for one not worth waiting for, such as who a mention names.
 */
export const sentOnce: RequestRetry = Object.freeze({ maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1 })

/** What the Atlassian host tools run on. */
export interface AtlassianHostOptions {
	/**
	 * Sends the requests to Jira and Confluence. Default: the global `fetch`. For a test, one that
	 * answers itself. It must drop the `authorization` header on a redirect to another host, as the
	 * global one does: an attachment's download is only sent to the site, but may be redirected.
	 */
	readonly fetch?: typeof fetch
	/** How a request the site didn't answer is sent again. Default: {@link defaultRequestRetry}. */
	readonly retry?: RequestRetry
}
