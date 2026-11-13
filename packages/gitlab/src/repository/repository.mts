import { tool } from '@mesh-flow/core'
import { BranchName, checkoutFolder, checkoutRepository, type Checkout } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { gitlabRemoteName, ProjectPath } from '../project-path.mts'
import { stubs } from '../stubs.mts'

/**
 * A checkout of a GitLab project in the workspace, on a branch. In a prompt it renders as where it
 * is on disk, so the agent finds it from any directory, including inside another checkout.
 */
export interface Repository extends Checkout {
	/** The project's path, such as `team/api`. */
	readonly name: ProjectPath
	readonly branch: BranchName
	readonly defaultBranch: BranchName
}

/**
 * Checks a project out into the workspace, on `branch`, which is made from the default branch when
 * GitLab doesn't have it yet. The clone comes from the host as a git bundle, so no credential
 * reaches the sandbox. A checkout of the project that is already there is reused, switched to
 * `branch` when it is on another; a folder left half-cloned is cloned again, and a folder of the
 * workflow's own that is no checkout is left alone, with an error. The checkout goes in a folder
 * at the project's whole path, in lower case, under `repositories/`.
 *
 * ```ts
 * const repository = await gitlab.checkout({ repository: 'team/api', branch: `feature/${story.key}` })
 * await developer.loop`Implement ${story} in ${repository}, then push with ${gitlab.push(repository)}.`
 * ```
 */
export const checkout = tool('gitlabCheckout', {
	description: 'Checks a GitLab project out into the workspace, on a branch',
	input: z.object({ repository: ProjectPath, branch: BranchName }),
	action: (input, context): Promise<Repository> =>
		checkoutRepository(
			{
				...input,
				folder: checkoutFolder(input.repository),
				remote: gitlabRemoteName(input.repository),
				clone: stubs.cloneRepository,
			},
			context,
		),
})
