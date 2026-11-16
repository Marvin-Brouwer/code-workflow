import { readsOnly, type FetchResends } from '@mesh-flow/gateway'

/** The searches that are sent as a POST, and read all the same: Jira Cloud's and Data Center's. */
const searchPath = /\/search(?:\/jql)?$/u

/** Who a mention names: worth one try, since without an answer the mention keeps what its link holds. */
const userPath = /\/user$/u

/**
 * The requests to Jira and Confluence that are sent again when the site didn't answer, or answered
 * 500, 502, 503, 504 or 429: reads, searches sent as a POST, and updates that set a value (`PUT`),
 * which the site may get twice. A request that makes something new, a comment or a transition, is
 * sent once: a retry after a lost answer would make it twice. So is a look-up of who a mention
 * names. An update sent again can write over a value set during the wait, such as a person's edit
 * of the comment: the wait is seconds, a risk taken for a site that drops answers far more often.
 */
export const atlassianResends: FetchResends = (request) => {
	if (userPath.test(request.url.pathname)) return false
	return readsOnly(request) || request.method === 'PUT' || (request.method === 'POST' && searchPath.test(request.url.pathname))
}
