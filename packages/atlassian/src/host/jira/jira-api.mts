import type { HostToolContext } from '@mesh-flow/gateway'
import { defaultRequestRetry, type AtlassianHostOptions } from '../host-options.mts'
import { readSiteSettings } from '../site-settings.mts'
import { jiraCloud } from './jira-cloud.mts'
import { jiraDataCenter } from './jira-data-center.mts'
import type { JiraSite } from './jira-site.mts'

/** A site for one call, with the settings from the credential store. */
export type JiraApi = (context: HostToolContext) => Promise<JiraSite>

/**
 * Opens Jira for host tools: every call reads the site and token from the credential store, so a
 * changed setting counts at once. With an email it's a Cloud site, signed in with the email and API
 * token; without one it's Data Center, with the token as a personal access token.
 */
export function jiraApi(options: AtlassianHostOptions = {}): JiraApi {
	return async (context) => {
		const settings = await readSiteSettings('jira', context)
		const common = {
			host: settings.url,
			retry: options.retry ?? defaultRequestRetry,
			// A site's custom configuration often differs from Atlassian's schema; the connector reads what it needs itself.
			onSchemaMismatch: 'silent' as const,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		}
		return settings.deployment === 'cloud'
			? jiraCloud({ ...common, auth: { type: 'basic', email: settings.email, apiToken: settings.token } })
			: jiraDataCenter({ ...common, auth: { type: 'bearer', token: settings.token } })
	}
}
