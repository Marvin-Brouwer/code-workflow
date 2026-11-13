import { connectorHost, type ConnectorHost, type HostTool } from '@mesh-flow/gateway'
import { gitlabApi, type GitlabApiOptions } from './api.mts'
import { gitRemote, type GitRemoteOptions } from './git-remote.mts'
import { gitHostTools } from './git-tools.mts'
import { mergeRequestHostTools } from './merge-request-tools.mts'
import { pipelineHostTools } from './pipeline-tools.mts'
import { projectHostTools } from './project-tools.mts'

/** What the GitLab host tools run on. */
export interface GitlabHostOptions extends GitlabApiOptions, GitRemoteOptions {}

/**
 * The host halves of every GitLab tool: the API calls and the git fetches and pushes, with the
 * token from the credential store under `gitlab/token`, on the GitLab under `gitlab/url`
 * (gitlab.com when it isn't set). For a test, `fetch` and `remoteUrl` point them at fakes of your own.
 */
export function gitlabHostTools(options: GitlabHostOptions): HostTool[] {
	const api = gitlabApi(options)
	return [...projectHostTools(api), ...mergeRequestHostTools(api), ...pipelineHostTools(api), ...gitHostTools(gitRemote(options))]
}

/** The GitLab connector's host half, as `mesh-flow connector add @mesh-flow/gitlab` loads it. */
export const connector: ConnectorHost = connectorHost('gitlab', ({ directory }) => gitlabHostTools({ directory }))
