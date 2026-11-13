import type { HostToolContext } from '@mesh-flow/gateway'
import { createClient, type Client } from 'jira.js/core'
import { defaultRequestRetry, type AtlassianHostOptions } from '../host-options.mts'
import { readSite } from '../site.mts'
import type { ConfluenceSite } from './confluence-site.mts'
import { RawPage, RawSearch, RawUser } from './raw-page.mts'

/** A Confluence site for one call, with the credentials from the credential store. */
export type ConfluenceApi = (context: HostToolContext) => Promise<ConfluenceSite>

/** What a read of a page expands: its rendered body, space and version. */
const pageExpand = 'body.view,space,version'

/** What a search expands: each result's space. */
const searchExpand = 'content.space'

/**
 * Opens Confluence for host tools, on REST API v1, which Cloud and Data Center share. Every call
 * reads the site and token from the credential store. With an email it's a Cloud site, under
 * `/wiki`, signed in with the email and API token; without one it's Data Center, with the token as a
 * personal access token.
 */
export function confluenceApi(options: AtlassianHostOptions = {}): ConfluenceApi {
	return async (context) => {
		const site = await readSite('confluence', context)
		const url = site.deployment === 'cloud' && !site.url.endsWith('/wiki') ? `${site.url}/wiki` : site.url
		const client = createClient({
			host: url,
			retry: options.retry ?? defaultRequestRetry,
			auth:
				site.deployment === 'cloud' ? { type: 'basic', email: site.email, apiToken: site.token } : { type: 'bearer', token: site.token },
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		})
		return confluenceSite(client, url)
	}
}

function confluenceSite(client: Client, url: string): ConfluenceSite {
	return {
		url,
		page: (id, abortSignal) =>
			client.sendRequest({
				url: `/rest/api/content/${encodeURIComponent(id)}`,
				searchParams: { expand: pageExpand },
				schema: RawPage,
				signal: abortSignal,
			}),
		search: (cql, limit, abortSignal) =>
			client.sendRequest({
				url: '/rest/api/search',
				searchParams: { cql, limit, expand: searchExpand, excerpt: 'highlight' },
				schema: RawSearch,
				signal: abortSignal,
			}),
		async user({ accountId, username }, abortSignal) {
			const searchParams = accountId === undefined ? (username === undefined ? undefined : { username }) : { accountId }
			if (searchParams === undefined) return undefined
			const user = await client.sendRequest({ url: '/rest/api/user', searchParams, schema: RawUser, signal: abortSignal })
			return { name: user.displayName, email: user.email }
		},
	}
}
