import { gitHostTools } from '@mesh-flow/code-repository/host'
import { connectorHost, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { cloneRepository, pushBundle } from '../tools/git-tools.mts'
import { gitlabApi, type GitlabApiOptions } from './api.mts'
import { gitRemote, type GitRemoteOptions } from './git-remote.mts'
import { mergeRequestHostTools } from './merge-request-tools.mts'
import { pipelineHostTools } from './pipeline-tools.mts'
import { searchHostTools } from './search-tools.mts'

/** What the GitLab host tools run on. */
export interface GitlabHostOptions extends GitlabApiOptions, GitRemoteOptions {}

/**
 * The host halves of every GitLab tool: the API calls and the git fetches and pushes, with the
 * token from the credential store under `gitlab/token`, on the GitLab under `gitlab/url`
 * (gitlab.com when it isn't set). The engine loads them itself with
 * `mesh-flow connector add @mesh-flow/gitlab`; call this when you embed a gateway of your own, or
 * to test a workflow against a fake GitLab.
 *
 * @param options - `directory`: where the host keeps its clones. For a test, `fetch` and
 * `remoteUrl` point the tools at fakes of your own; `retry` sets how a failed request is sent again.
 * @returns The host tools, for the gateway.
 *
 * @example A test against a fake GitLab
 * ```ts
 * import { gitlabHostTools } from '@mesh-flow/gitlab/host'
 *
 * const tools = gitlabHostTools({
 * 	directory: '/tmp/gitlab-host',
 * 	fetch: (input, init) => fetch(String(input).replace('https://gitlab.com', 'http://127.0.0.1:4010'), init),
 * 	remoteUrl: (project) => `file:///tmp/remotes/${project}.git`,
 * 	retry: { attempts: 1, firstDelayMs: 0, longestRetryAfterMs: 0, attemptTimeoutMs: 1000 },
 * })
 * ```
 */
export function gitlabHostTools(options: GitlabHostOptions): HostTool[] {
	const api = gitlabApi(options)
	return [
		...searchHostTools(api),
		...mergeRequestHostTools(api),
		...pipelineHostTools(api),
		...gitHostTools(gitRemote(options), { cloneRepository, pushBundle }),
	]
}

/**
 * The GitLab connector's host half, as `mesh-flow connector add @mesh-flow/gitlab` loads it:
 * {@link gitlabHostTools} with the defaults. Set the token, and the URL of a GitLab of your own,
 * with `mesh-flow credential set`.
 *
 * @example
 * ```sh
 * mesh-flow connector add @mesh-flow/gitlab
 * mesh-flow credential set gitlab/token < token.txt
 * echo 'https://gitlab.example.com' | mesh-flow credential set gitlab/url   # not for gitlab.com
 * ```
 */
export const connector: ConnectorHost = connectorHost('gitlab', ({ directory }) => gitlabHostTools({ directory }))
