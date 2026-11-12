import { connectorHost, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { confluenceApi } from './confluence/confluence-api.mts'
import { confluenceHostTools } from './confluence/confluence-host-tools.mts'
import { jiraApi } from './jira/jira-api.mts'
import { jiraHostTools } from './jira/jira-host-tools.mts'

/** What the Atlassian host tools run on. */
export interface AtlassianHostOptions {
	/** Sends the requests to Jira and Confluence. Default: the global `fetch`. For a test, one that answers itself. */
	readonly fetch?: typeof fetch
}

/**
 * The host halves of every Jira and Confluence tool, with each product's site and token from the
 * credential store (see `settingNames`).
 */
export function atlassianHostTools(options: AtlassianHostOptions = {}): HostTool[] {
	return [...jiraHostTools(jiraApi(options)), ...confluenceHostTools(confluenceApi(options))]
}

/** The Atlassian connector's host half, as `mesh-flow connector add @mesh-flow/atlassian` loads it. */
export const connector: ConnectorHost = connectorHost('atlassian', () => atlassianHostTools())
