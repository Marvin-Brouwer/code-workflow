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
 * token from the credential store under `github/token`. For a test, `apiUrl` and `remoteUrl` point
 * them at a server of your own.
 */
export function githubHostTools(options: GithubHostOptions): HostTool[] {
	const api = githubApi(options)
	return [...issueHostTools(api), ...pullRequestHostTools(api), ...gitHostTools(gitRemote(options), { cloneRepository, pushBundle })]
}

/** The GitHub connector's host half, as `mesh-flow connector add @mesh-flow/github` loads it. */
export const connector: ConnectorHost = connectorHost('github', ({ directory }) => githubHostTools({ directory }))
