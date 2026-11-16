import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import type { CodeHostTerms } from '../describe/change-request.mts'
import type { Checkout } from './checkout.mts'
import { branchHeadOf } from './push.mts'

/**
 * A connector's tool that reads which commit a checkout's branch is at: the checkout's `HEAD`, or
 * with `pushed` the branch as it was last pushed, which is what an open pull or merge request
 * shows. It is named after the code host, such as `gitlabBranchHead`.
 */
export function branchHeadTool(terms: CodeHostTerms, repository: Checkout): Tool<{ pushed: boolean }, string> {
	return tool(`${terms.toolPrefix}BranchHead`, {
		description: `Reads which commit the branch of ${repository.directory} is at`,
		input: z.object({ pushed: z.boolean() }),
		action: ({ pushed }, context) => branchHeadOf(repository, pushed, context),
	})
}
