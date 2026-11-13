/**
 * The host half of the GitHub connector: the tools that run on the host with the GitHub token,
 * which the engine loads with `mesh-flow connector add @mesh-flow/github`.
 *
 * @module
 */
export { tokenCredential } from '../host/api.mts'
export { connector, githubHostTools, type GithubHostOptions } from '../host/connector.mts'
export { defaultFetchRetry, type FetchRetryOptions } from '@mesh-flow/code-repository/host'
