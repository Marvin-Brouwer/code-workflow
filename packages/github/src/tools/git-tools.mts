import { Bundle, Sha } from '@mesh-flow/forge'
import { z } from 'zod'
import { BranchName, RepositoryName } from '../repository-name.mts'

export { Bundle, Sha }

/** Clones on the host; the sandbox gets a bundle, never the credential. */
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

/** Pushes on the host what the sandbox bundled; the host checks the branch ends up at the bundle's head. */
export const pushBundle = {
	name: 'githubPush',
	description: 'Pushes the commits in a git bundle to a branch of a GitHub repository',
	input: z.object({ repository: RepositoryName, branch: BranchName, bundle: Bundle }),
	output: z.object({ head: Sha }),
}
