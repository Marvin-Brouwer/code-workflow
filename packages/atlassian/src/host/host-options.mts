import type { FetchRetryOptions } from '@mesh-flow/gateway'

/** What the Atlassian host tools run on. */
export interface AtlassianHostOptions {
	/**
	 * Sends the requests to Jira and Confluence. Default: the global `fetch`. For a test, one that
	 * answers itself. It must drop the `authorization` header on a redirect to another host, as the
	 * global one does: an attachment's download is only sent to the site, but may be redirected.
	 */
	readonly fetch?: typeof fetch
	/** How a request the site didn't answer is sent again (see `atlassianResends`). Default: `defaultFetchRetry`. */
	readonly retry?: FetchRetryOptions
}
