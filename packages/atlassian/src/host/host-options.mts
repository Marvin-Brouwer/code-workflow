import { readsOnly, type FetchResends, type FetchRetryOptions } from '@mesh-flow/gateway'

/** The searches that are sent as a POST, and read all the same: Jira Cloud's and Data Center's. */
const searchPath = /\/search(?:\/jql)?$/u

/** Who a mention names: worth one try, since without an answer the mention keeps what its link holds. */
const userPath = /\/user$/u

/**
 * The requests to Jira and Confluence that are sent again when the site didn't answer, or answered
 * 5xx or 429: reads, searches sent as a POST, and updates that set a value (`PUT`), which the site
 * may get twice. A request that makes something new, a comment or a transition, is sent once: a
 * retry after a lost answer would make it twice. So is a look-up of who a mention names.
 */
export const atlassianResends: FetchResends = (request) => {
	if (userPath.test(request.url.pathname)) return false
	return readsOnly(request) || request.method === 'PUT' || (request.method === 'POST' && searchPath.test(request.url.pathname))
}

/** What the Atlassian host tools run on. */
export interface AtlassianHostOptions {
	/**
	 * Sends the requests to Jira and Confluence. Default: the global `fetch`. For a test, one that
	 * answers itself. It must drop the `authorization` header on a redirect to another host, as the
	 * global one does: an attachment's download is only sent to the site, but may be redirected.
	 */
	readonly fetch?: typeof fetch
	/** How a request the site didn't answer is sent again (see {@link atlassianResends}). Default: `defaultFetchRetry`. */
	readonly retry?: FetchRetryOptions
}
