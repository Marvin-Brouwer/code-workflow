/**
 * The host half of the Atlassian connector: the Jira and Confluence tools that run on the host with
 * the tokens, which the engine loads with `mesh-flow connector add @mesh-flow/atlassian`.
 *
 * @module
 */
export { atlassianHostTools, connector } from '../host/connector.mts'
export { defaultRequestRetry, type AtlassianHostOptions, type RequestRetry } from '../host/host-options.mts'
export { credentialNames, type Product } from '../host/site.mts'
