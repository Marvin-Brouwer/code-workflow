import { gitHostTools } from '@mesh-flow/code-repository/host'
import { connectorHost, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { cloneRepository, pushBundle } from '../tools/git-tools.mts'
import { githubApi, type GithubApiOptions } from './api.mts'
import { gitRemote, type GitRemoteOptions } from './git-remote.mts'
import { issueHostTools } from './issue-tools.mts'
import { pullRequestHostTools } from './pull-request-tools.mts'

/** What the GitHub host tools run on. */
export interface GithubHostOptions extends GithubApiOptions, GitRemoteOptions {}

/**
 * The host halves of every GitHub tool: the API calls and the git fetches and pushes, with the
 * token from the credential store under `github/token`. The engine loads them itself with
 * `mesh-flow connector add @mesh-flow/github`; call this when you embed a gateway of your own, or to
 * test a workflow against a GitHub of your own.
 *
 * @param options - `directory`: where the host keeps its clones. For a test, `apiUrl` and
 * `remoteUrl` point the tools at a server of your own; `retry` sets how a failed read is sent again.
 * @returns The host tools, for the gateway.
 *
 * @example A test against a fake GitHub
 * ```ts
 * import { githubHostTools } from '@mesh-flow/github/host'
 *
 * const tools = githubHostTools({ directory: clones, apiUrl: fakeGithub.url, remoteUrl: (repository) => path.join(remotes, `${repository}.git`) })
 * ```
 */
export function githubHostTools(options: GithubHostOptions): HostTool[] {
	const api = githubApi(options)
	return [...issueHostTools(api), ...pullRequestHostTools(api), ...gitHostTools(gitRemote(options), { cloneRepository, pushBundle })]
}

/**
 * The GitHub connector's host half, as `mesh-flow connector add @mesh-flow/github` loads it:
 * {@link githubHostTools} with the defaults. Set the token with `mesh-flow credential set`.
 *
 * @example
 * ```sh
 * mesh-flow connector add @mesh-flow/github
 * mesh-flow credential set github/token < token.txt
 * ```
 */
export const connector: ConnectorHost = connectorHost('github', ({ directory }) => githubHostTools({ directory }))
