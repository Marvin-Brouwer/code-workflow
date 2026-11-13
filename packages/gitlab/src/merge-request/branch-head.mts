import { tool, type Tool } from '@mesh-flow/core'
import { branchHeadOf } from '@mesh-flow/code-repository'
import { z } from 'zod'
import type { Repository } from '../repository/repository.mts'

/**
 * The tool that reads which commit a checkout's branch is at: the checkout's `HEAD`, or with
 * `pushed` the branch as it was last pushed, which is what an open merge request shows.
 */
export function branchHead(repository: Repository): Tool<{ pushed: boolean }, string> {
	return tool('gitlabBranchHead', {
		description: `Reads which commit the branch of ${repository.directory} is at`,
		input: z.object({ pushed: z.boolean() }),
		action: ({ pushed }, context) => branchHeadOf(repository, pushed, context),
	})
}
