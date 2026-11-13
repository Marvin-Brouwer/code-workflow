import { gitRemote as sharedGitRemote, type GitRemote } from '@mesh-flow/code-repository/host'
import { basicAuthHeaderEnv } from '@mesh-flow/git'
import { githubRemoteUrl, splitRepositoryName } from '../repository-name.mts'
import { requireToken } from './api.mts'

export type { GitRemote }

/** Where the host clones live and how it reaches GitHub over git. */
export interface GitRemoteOptions {
	/** The connector's own directory: one bare clone per repository goes in it, under `owner/`. */
	readonly directory: string
	/** The URL to clone `owner/name` from. Default: GitHub over HTTPS. */
	readonly remoteUrl?: (repository: string) => string
}

/** Clones of GitHub repositories on the host, under `options.directory`, fetched and pushed with the GitHub token. */
export function gitRemote(options: GitRemoteOptions): GitRemote {
	return sharedGitRemote({
		directory: options.directory,
		remoteUrl: options.remoteUrl ?? githubRemoteUrl,
		cloneSegments: (repository) => {
			const { owner, repo } = splitRepositoryName(repository)
			return [owner, repo]
		},
		credentialEnv: async (context) => basicAuthHeaderEnv('x-access-token', await requireToken(context)),
	})
}
