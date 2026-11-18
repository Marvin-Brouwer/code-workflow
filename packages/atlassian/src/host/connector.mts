import { connectorHost, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { confluenceApi } from './confluence/confluence-api.mts'
import { confluenceHostTools } from './confluence/confluence-host-tools.mts'
import type { AtlassianHostOptions } from './host-options.mts'
import { jiraApi } from './jira/jira-api.mts'
import { jiraHostTools } from './jira/jira-host-tools.mts'

/**
 * The host halves of every Jira and Confluence tool, with each product's site and token read from
 * the gateway's credential store on every call (see `credentialNames`). The engine loads them
 * itself with `mesh-flow connector add @mesh-flow/atlassian`; call this when you embed a gateway of
 * your own, or to test a workflow against a fake site.
 *
 * @param options - What the tools send requests with, and how they retry. Defaults: the global
 * `fetch` and `defaultFetchRetry`.
 * @returns The host tools, for the gateway.
 *
 * @example A test against a fake site
 * ```ts
 * import { atlassianHostTools, defaultFetchRetry } from '@mesh-flow/atlassian/host'
 *
 * const tools = atlassianHostTools({ fetch: fakeSite.fetch, retry: { ...defaultFetchRetry, waits: [] } })
 * ```
 */
export function atlassianHostTools(options: AtlassianHostOptions = {}): HostTool[] {
	return [...jiraHostTools(jiraApi(options)), ...confluenceHostTools(confluenceApi(options))]
}

/**
 * The Atlassian connector's host half, as `mesh-flow connector add @mesh-flow/atlassian` loads it:
 * {@link atlassianHostTools} with the defaults. Set the sites and tokens it reads with
 * `mesh-flow credential set` (see `credentialNames`).
 *
 * @example
 * ```sh
 * mesh-flow connector add @mesh-flow/atlassian
 * echo 'https://example.atlassian.net' | mesh-flow credential set jira/url
 * echo 'bot@example.com' | mesh-flow credential set jira/email   # Cloud only
 * mesh-flow credential set jira/token < api-token.txt
 * ```
 */
export const connector: ConnectorHost = connectorHost('atlassian', () => atlassianHostTools())
