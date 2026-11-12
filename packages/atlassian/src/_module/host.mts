/**
 * The host half of the Atlassian connector: the Jira and Confluence tools that run on the host with
 * the tokens, which the engine loads with `mesh-flow connector add @mesh-flow/atlassian`.
 *
 * @module
 */
export { atlassianHostTools, connector, type AtlassianHostOptions } from '../host/connector.mts'
export { settingNames, type Product } from '../host/site-settings.mts'
