import { gitClient, type GitClient } from '@mesh-flow/git'

/** How a commit made by a workflow in the sandbox is signed. */
export const committer = { name: 'mesh-flow', email: 'mesh-flow@users.noreply.github.com' }

/**
 * The committer as git's environment, which wins over any config and over the same variables in
 * the sandbox's own environment: a commit is mesh-flow's, both as author and as committer.
 */
const committerEnv = Object.freeze({
	GIT_AUTHOR_NAME: committer.name,
	GIT_AUTHOR_EMAIL: committer.email,
	GIT_COMMITTER_NAME: committer.name,
	GIT_COMMITTER_EMAIL: committer.email,
})

/**
 * Git for a checkout in the sandbox, committing as mesh-flow. No credential is anywhere near it:
 * fetching and pushing go through the host. Aborting the signal kills whatever runs.
 */
export function localGit(directory: string, abortSignal: AbortSignal): GitClient {
	return gitClient({ cwd: directory, env: committerEnv, abortSignal })
}
