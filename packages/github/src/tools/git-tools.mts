import { z } from 'zod'
import { BranchName, RepositoryName } from '../repository-name.mts'

/** A git bundle, base64: how commits cross between the host and the sandbox without a credential. */
export const Bundle = z.base64()

/** A commit id. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/)

export const cloneRepository = {
	name: 'githubClone',
	description:
		'Fetches a GitHub repository on the host and returns it as a git bundle holding its default branch and, when it exists, the branch',
	input: z.object({ repository: RepositoryName, branch: BranchName }),
	output: z.object({
		bundle: Bundle,
		defaultBranch: BranchName,
		/** Whether the branch exists on GitHub. When it doesn't, the bundle holds the default branch only. */
		branchExists: z.boolean(),
	}),
}

export const pushBundle = {
	name: 'githubPush',
	description: 'Pushes the commits in a git bundle to a branch of a GitHub repository',
	input: z.object({ repository: RepositoryName, branch: BranchName, bundle: Bundle }),
	output: z.object({ head: Sha }),
}
