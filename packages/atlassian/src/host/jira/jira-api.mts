import type { HostToolContext } from '@mesh-flow/gateway'
import { defaultRequestRetry, type AtlassianHostOptions } from '../host-options.mts'
import { readSite } from '../site.mts'
import { jiraCloud } from './jira-cloud.mts'
import { jiraDataCenter } from './jira-data-center.mts'
import type { JiraSite } from './jira-site.mts'
import type { Download } from './attachments.mts'

/** A site for one call, with the credentials from the credential store, and how to read its attachments. */
export type JiraApi = (context: HostToolContext) => Promise<JiraSite & { readonly download: Download }>

/**
 * Opens Jira for host tools: every call reads the site and token from the credential store, so a
 * changed setting counts at once. With an email it's a Cloud site, signed in with the email and API
 * token; without one it's Data Center, with the token as a personal access token.
 */
export function jiraApi(options: AtlassianHostOptions = {}): JiraApi {
	return async (context) => {
		const site = await readSite('jira', context)
		const common = {
			host: site.url,
			retry: options.retry ?? defaultRequestRetry,
			// A site's custom configuration often differs from Atlassian's schema; the connector reads what it needs itself.
			onSchemaMismatch: 'silent' as const,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		}
		const jira =
			site.deployment === 'cloud'
				? jiraCloud({ ...common, auth: { type: 'basic', email: site.email, apiToken: site.token } })
				: jiraDataCenter({ ...common, auth: { type: 'bearer', token: site.token } })
		const authorization =
			site.deployment === 'cloud' ? `Basic ${Buffer.from(`${site.email}:${site.token}`).toString('base64')}` : `Bearer ${site.token}`
		return { ...jira, download: downloadWith(options.fetch ?? fetch, authorization) }
	}
}

/**
 * Reads an attachment signed in, as the API does. A file that can't be read, gone or refused or the
 * site down, is `undefined`: the issue is still worth reading without it. A stop is thrown.
 */
function downloadWith(send: typeof fetch, authorization: string): Download {
	return async (url, abortSignal) => {
		try {
			const response = await send(url, { headers: { authorization }, signal: abortSignal })
			return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined
		} catch (error) {
			abortSignal.throwIfAborted()
			if (error instanceof TypeError) return undefined
			throw error
		}
	}
}
