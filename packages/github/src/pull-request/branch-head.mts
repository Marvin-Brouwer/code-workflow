import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { localGit } from '@mesh-flow/forge'
import { trackingRef, type Repository } from '../repository/repository.mts'

/**
 * The tool that reads which commit a checkout's branch is at: the checkout's `HEAD`, or with
 * `pushed` the branch as it was last pushed, which is what an open pull request shows.
 */
export function branchHead(repository: Repository): Tool<{ pushed: boolean }, string> {
	return tool('githubBranchHead', {
		description: `Reads which commit the branch of ${repository.directory} is at`,
		input: z.object({ pushed: z.boolean() }),
		action: async ({ pushed }, { abortSignal }) => {
			const git = localGit(repository.directory, abortSignal)
			const tracking = trackingRef(repository.branch)
			const head = pushed && (await git.hasRef(tracking)) ? tracking : 'HEAD'
			return (await git.revParse(head)).stdout.trim()
		},
	})
}
