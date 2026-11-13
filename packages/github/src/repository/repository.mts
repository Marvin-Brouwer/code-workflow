import { tool } from '@mesh-flow/core'
import { checkoutRepository, type Checkout } from '@mesh-flow/forge'
import { z } from 'zod'
import { BranchName, githubRemoteUrl, RepositoryName, splitRepositoryName } from '../repository-name.mts'
import { stubs } from '../stubs.mts'

/**
 * A checkout of a GitHub repository in the workspace, on a branch. In a prompt it renders as where it
 * is on disk, so the agent finds it from any directory, including inside another checkout.
 */
export interface Repository extends Checkout {
	/** `owner/name`. */
	readonly name: RepositoryName
	readonly branch: BranchName
	readonly defaultBranch: BranchName
}

/**
 * Checks a repository out into the workspace, on `branch`, which is made from the default branch
 * when GitHub doesn't have it yet. The clone comes from the host as a git bundle, so no credential
 * reaches the sandbox. A checkout of the repository that is already there is reused, switched to
 * `branch` when it is on another; a folder left half-cloned is cloned again, and a folder of the
 * workflow's own that is no checkout is left alone, with an error.
 *
 * ```ts
 * const repository = await github.checkout({ repository: 'team/app', branch: `fix/${String(issue.number)}` })
 * await developer.loop`Fix ${issue} in ${repository}, then push with ${github.push(repository)}.`
 * ```
 */
export const checkout = tool('githubCheckout', {
	description: 'Checks a GitHub repository out into the workspace, on a branch',
	input: z.object({ repository: RepositoryName, branch: BranchName }),
	action: (input, context): Promise<Repository> =>
		checkoutRepository(
			{
				...input,
				folder: splitRepositoryName(input.repository).repo,
				remoteUrl: githubRemoteUrl(input.repository),
				clone: stubs.cloneRepository,
			},
			context,
		),
})
