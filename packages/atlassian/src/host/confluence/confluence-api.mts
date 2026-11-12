import type { HostToolContext } from '@mesh-flow/gateway'
import { createClient, type Client } from 'jira.js/core'
import { z } from 'zod'
import { readSiteSettings } from '../site-settings.mts'

/** How the Confluence host tools reach Confluence. */
export interface ConfluenceApiOptions {
	/** Sends the requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
}

/** A Confluence site for one call. */
export interface ConfluenceSite {
	/** Where pages are opened, for links: the site with `/wiki` on Cloud. */
	readonly url: string
	readonly page: (id: string, abortSignal: AbortSignal) => Promise<RawPage>
	readonly search: (cql: string, limit: number, abortSignal: AbortSignal) => Promise<RawSearch>
}

/** A Confluence site for one call, with the settings from the credential store. */
export type ConfluenceApi = (context: HostToolContext) => Promise<ConfluenceSite>

/** A page as REST API v1 has it, which Cloud and Data Center share. */
export const RawPage = z.object({
	id: z.string(),
	title: z.string(),
	space: z.object({ key: z.string() }).nullish(),
	version: z.object({ number: z.int(), when: z.string().default('') }).nullish(),
	body: z.object({ view: z.object({ value: z.string() }).nullish() }).nullish(),
	// Named as Confluence names it; `links` below reads it.
	_links: z.object({ webui: z.string().optional(), next: z.string().optional() }).default({}),
})
export type RawPage = z.infer<typeof RawPage>

/** The links Confluence puts next to what it answers: where a page opens, and the next page of results. */
export function linksOf(answer: { readonly _links: { readonly webui?: string | undefined; readonly next?: string | undefined } }) {
	return answer['_links']
}

/** A page of search results as REST API v1 has it. */
export const RawSearch = z.object({
	results: z.array(RawPage.extend({ excerpt: z.string().nullish() })),
	_links: z.object({ webui: z.string().optional(), next: z.string().optional() }).default({}),
})
export type RawSearch = z.infer<typeof RawSearch>

/** How often a request that Confluence didn't answer, or answered 502, 503 or 504, is sent; each wait doubles. */
const retry = Object.freeze({ maxAttempts: 4, initialDelayMs: 500, backoffFactor: 2 })

/** What a read of a page expands: its rendered body, space and version. */
const pageExpand = 'body.view,space,version'

/**
 * Opens Confluence for host tools, on REST API v1, which Cloud and Data Center share. Every call
 * reads the site and token from the credential store. With an email it's a Cloud site, under
 * `/wiki`, signed in with the email and API token; without one it's Data Center, with the token as a
 * personal access token.
 */
export function confluenceApi(options: ConfluenceApiOptions = {}): ConfluenceApi {
	return async (context) => {
		const settings = await readSiteSettings('confluence', context)
		const url = settings.deployment === 'cloud' && !settings.url.endsWith('/wiki') ? `${settings.url}/wiki` : settings.url
		const client = createClient({
			host: url,
			retry,
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
				url: '/rest/api/content/search',
				searchParams: { cql, limit, expand: 'space' },
				schema: RawSearch,
				signal: abortSignal,
			}),
	}
}
