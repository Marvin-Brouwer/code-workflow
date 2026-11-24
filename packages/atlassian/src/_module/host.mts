/**
 * The host half of the Atlassian connector: the Jira and Confluence tools that run on the host with
 * the tokens, which the engine loads with `mesh-flow connector add @mesh-flow/atlassian`.
 *
 * @module
 */
export { defaultFetchRetry, type FetchRetryOptions } from '@mesh-flow/gateway'
export { atlassianHostTools, connector } from '../host/connector.mts'
export { atlassianResends } from '../host/atlassian-resends.mts'
export type { AtlassianHostOptions } from '../host/host-options.mts'
export { cloudCredentialNames, dataCenterCredentialNames, type Product } from '../host/site.mts'
