import { gitRemote as sharedGitRemote, type GitRemote } from '@mesh-flow/code-repository/host'
import type { HostToolContext } from '@mesh-flow/gateway'
import { basicAuthHeaderEnv } from '@mesh-flow/git'
import { readSite } from './site.mts'

/** Where the host clones live and how it reaches GitLab over git. */
export interface GitRemoteOptions {
	/** The connector's own directory: one bare clone per project goes in it, under its groups. */
	readonly directory: string
	/** The URL to clone a project from. Default: the GitLab of the credential store over HTTPS. */
	readonly remoteUrl?: (project: string, context: HostToolContext) => string | Promise<string>
}

/** Clones of GitLab projects on the host, under `options.directory`, fetched and pushed with the GitLab token. */
export function gitRemote(options: GitRemoteOptions): GitRemote {
	return sharedGitRemote({
		directory: options.directory,
		remoteUrl: options.remoteUrl ?? (async (project, context) => `${(await readSite(context)).url}/${project}.git`),
		// The path's segments were checked by `ProjectPath`: none is `.` or `..`. GitLab ignores case in
		// paths, so `Team/Api` and `team/api` share one clone, and one call at a time.
		cloneSegments: (project) => project.toLowerCase().split('/'),
		// GitLab takes a token as the password of any user name; `oauth2` is the one its docs use.
		credentialEnv: async (context) => basicAuthHeaderEnv('oauth2', (await readSite(context)).token),
	})
}
