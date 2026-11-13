/**
 * The host half of the GitLab connector: the tools that run on the host with the GitLab token,
 * which the engine loads with `mesh-flow connector add @mesh-flow/gitlab`.
 *
 * @module
 */
export { defaultFetchRetry, type FetchRetryOptions } from '@mesh-flow/code-repository/host'
export { connector, gitlabHostTools, type GitlabHostOptions } from '../host/connector.mts'
export { tokenCredential, urlCredential } from '../host/site.mts'
