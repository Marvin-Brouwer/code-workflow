import type { HostToolContext } from '@mesh-flow/gateway'
import { readSiteSettings } from '../site-settings.mts'
import { jiraCloud } from './jira-cloud.mts'
import { jiraDataCenter } from './jira-data-center.mts'
import type { JiraSite } from './jira-site.mts'

/** How the Jira host tools reach Jira. */
export interface JiraApiOptions {
	/** Sends the requests. Default: the global `fetch`. */
	readonly fetch?: typeof fetch
}

/** A site for one call, with the settings from the credential store. */
export type JiraApi = (context: HostToolContext) => Promise<JiraSite>

/**
 * How often a request that Jira didn't answer, or answered 502, 503 or 504, is sent again, and how
 * long the first wait is; each wait doubles.
 */
const retry = Object.freeze({ maxAttempts: 4, initialDelayMs: 500, backoffFactor: 2 })

/**
 * Opens Jira for host tools: every call reads the site and token from the credential store, so a
 * changed setting counts at once. With an email it's a Cloud site, signed in with the email and API
 * token; without one it's Data Center, with the token as a personal access token.
 */
export function jiraApi(options: JiraApiOptions = {}): JiraApi {
	return async (context) => {
		const settings = await readSiteSettings('jira', context)
		const common = {
			host: settings.url,
			retry,
			// A site's custom configuration often differs from Atlassian's schema; the connector reads what it needs itself.
			onSchemaMismatch: 'silent' as const,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		}
		return settings.deployment === 'cloud'
			? jiraCloud({ ...common, auth: { type: 'basic', email: settings.email, apiToken: settings.token } })
			: jiraDataCenter({ ...common, auth: { type: 'bearer', token: settings.token } })
	}
}
