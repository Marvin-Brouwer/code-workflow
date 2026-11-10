import { gitClient, type GitClient } from '@mesh-flow/git'

/** How a commit made by a workflow in the sandbox is signed. */
export const committer = { name: 'mesh-flow', email: 'mesh-flow@users.noreply.github.com' }

/**
 * Git for a checkout in the sandbox, committing as mesh-flow. No credential is anywhere near it:
 * fetching and pushing go through the host. Aborting the signal kills whatever runs.
 */
export function localGit(directory: string, abortSignal: AbortSignal): GitClient {
	return gitClient({ cwd: directory, config: { 'user.name': committer.name, 'user.email': committer.email }, abortSignal })
}
