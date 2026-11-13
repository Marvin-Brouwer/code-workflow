/**
 * How Jira and Confluence requests are sent again when the site didn't answer, or answered 502, 503
 * or 504. Reads and updates are; requests that make something new, a comment or a transition, are
 * sent once. The shape is jira.js's own retry setting, which it is handed to as it is, so it
 * differs from the `FetchRetryOptions` of the code host connectors, which retry on their own.
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

/** No retry: for a request that makes something, such as a comment, which a retry after a lost answer would make twice. */
export const sentOnce: RequestRetry = Object.freeze({ maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1 })

/** What the Atlassian host tools run on. */
export interface AtlassianHostOptions {
	/** Sends the requests to Jira and Confluence. Default: the global `fetch`. For a test, one that answers itself. */
	readonly fetch?: typeof fetch
	/** How a request the site didn't answer is sent again. Default: {@link defaultRequestRetry}. */
	readonly retry?: RequestRetry
}
