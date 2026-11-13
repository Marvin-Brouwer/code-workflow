import { Bundle, BranchName, Sha } from '@mesh-flow/forge'
import { z } from 'zod'
import { ProjectPath } from '../project-path.mts'

/** Clones on the host; the sandbox gets a bundle, never the credential. */
export const cloneRepository = {
	name: 'gitlabClone',
	description:
		'Fetches a GitLab project on the host and returns it as a git bundle holding its default branch and, when it exists, the branch',
	input: z.object({ repository: ProjectPath, branch: BranchName }),
	output: z.object({
		bundle: Bundle,
		defaultBranch: BranchName,
		/** Whether the branch exists on GitLab. When it doesn't, the bundle holds the default branch only. */
		branchExists: z.boolean(),
	}),
}

/** Pushes on the host what the sandbox bundled; the host checks the branch ends up at the bundle's head. */
export const pushBundle = {
	name: 'gitlabPush',
	description: 'Pushes the commits in a git bundle to a branch of a GitLab project',
	input: z.object({ repository: ProjectPath, branch: BranchName, bundle: Bundle }),
	output: z.object({ head: Sha }),
}
