import { tool } from '@mesh-flow/core'
import { BranchName, checkoutRepository, type Checkout } from '@mesh-flow/forge'
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
 * named after the project's last segment.
 *
 * ```ts
 * const repository = await gitlab.checkout('team/api', { branch: `feature/${story.key}` })
 * await developer.loop`Implement ${story} in ${repository}, then push with ${gitlab.push(repository)}.`
 * ```
 */
export function checkout(project: ProjectPath, options: { readonly branch: BranchName }): Promise<Repository> {
	return checkoutTool({ repository: project, branch: options.branch })
}

/** The checkout as a tool, so a run that starts over finds it done. */
const checkoutTool = tool('gitlabCheckout', {
	description: 'Checks a GitLab project out into the workspace, on a branch',
	input: z.object({ repository: ProjectPath, branch: BranchName }),
	action: (input, context): Promise<Repository> =>
		checkoutRepository(
			{
				...input,
				folder: input.repository.split('/').at(-1) ?? input.repository,
				remoteUrl: gitlabRemoteName(input.repository),
				clone: stubs.cloneRepository,
			},
			context,
		),
})
