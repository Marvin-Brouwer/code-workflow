/**
 * What the connectors of code forges share on the host's side: clones that fetch and push with the
 * credential, requests tried again when the connection drops, one call at a time per key, and the
 * footer every post is signed with.
 *
 * @module
 */
export { gitRemote, type GitRemote, type GitRemoteOptions } from '../host/git-remote.mts'
export { unavailable } from '../host/http-statuses.mts'
export { oneAtATime, type OneAtATime } from '../host/one-at-a-time.mts'
export { defaultFetchRetry, retryingFetch, type FetchRetryOptions } from '../host/retrying-fetch.mts'
export { runIdLine, signed, unsigned, withoutRunId, withUnixLineBreaks } from '../host/signature.mts'
