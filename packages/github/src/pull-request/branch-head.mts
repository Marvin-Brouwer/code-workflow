import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { localGit } from '../repository/local-git.mts'
import { origin, type Repository } from '../repository/repository.mts'

/**
 * The tool that reads which commit a checkout's branch is at: the checkout's `HEAD`, or with
 * `pushed` the branch as it was last pushed, which is what an open pull request shows.
 */
export function branchHead(repository: Repository): Tool<{ pushed: boolean }, string> {
	return tool('githubBranchHead', {
		description: `Reads which commit the branch of ${repository.path} is at`,
		input: z.object({ pushed: z.boolean() }),
		action: async ({ pushed }, { abortSignal }) => {
			const git = localGit(repository.directory, abortSignal)
			const tracking = `refs/remotes/${origin}/${repository.branch}`
			const head = pushed && (await git.hasRef(tracking)) ? tracking : 'HEAD'
			return (await git.revParse(head)).stdout.trim()
		},
	})
}
