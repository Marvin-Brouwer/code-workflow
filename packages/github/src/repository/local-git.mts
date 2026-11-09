import { runGit } from '../git-process.mts'

/** How a commit made by a workflow in the sandbox is signed. */
export const committer = { name: 'mesh-flow', email: 'mesh-flow@users.noreply.github.com' }

/**
 * Runs git in a checkout in the sandbox. No credential is anywhere near it: fetching and pushing
 * go through the host. Aborting the signal kills the process.
 */
export function localGit(cwd: string, args: readonly string[], abortSignal: AbortSignal): Promise<string> {
	return runGit(
		cwd,
		args,
		{
			GIT_AUTHOR_NAME: committer.name,
			GIT_AUTHOR_EMAIL: committer.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
		},
		abortSignal,
	)
}

/** Whether `ref` names a commit in the checkout. */
export function hasRef(cwd: string, ref: string, abortSignal: AbortSignal): Promise<boolean> {
	return localGit(cwd, ['rev-parse', '--verify', '--quiet', ref], abortSignal).then(
		() => true,
		() => false,
	)
}
