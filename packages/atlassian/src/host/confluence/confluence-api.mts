import type { HostToolContext } from '@mesh-flow/gateway'
import { createClient, type Client } from 'jira.js/core'
import { defaultRequestRetry, type AtlassianHostOptions } from '../host-options.mts'
import { readSiteSettings } from '../site-settings.mts'
import type { ConfluenceSite } from './confluence-site.mts'
import { RawPage, RawSearch } from './raw-page.mts'

/** A Confluence site for one call, with the settings from the credential store. */
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
		const settings = await readSiteSettings('confluence', context)
		const url = settings.deployment === 'cloud' && !settings.url.endsWith('/wiki') ? `${settings.url}/wiki` : settings.url
		const client = createClient({
			host: url,
			retry: options.retry ?? defaultRequestRetry,
			auth:
				settings.deployment === 'cloud'
					? { type: 'basic', email: settings.email, apiToken: settings.token }
					: { type: 'bearer', token: settings.token },
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
	}
}
