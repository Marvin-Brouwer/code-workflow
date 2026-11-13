import { tool, type Tool } from '@mesh-flow/core'
import { pushCheckout, type Pushed } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import type { Repository } from './repository.mts'

export type { Pushed }

/**
 * The tool that commits every change in the checkout and pushes the branch, for an agent to call
 * when its work is ready, and for code before a merge request. The commits go to the host as a git
 * bundle of what GitLab doesn't have yet (on top of the default branch for a new branch), and the
 * host pushes them with the token.
 *
 * ```ts
 * await developer.loop`Fix the pipeline in ${repository}. Push with ${gitlab.push(repository)}, then ${succeed()}.`
 * ```
 */
export function push(repository: Repository): Tool<{ message: string }, Pushed> {
	return tool('push', {
		description: `Commits every change in ${repository.directory} with the message and pushes the branch to GitLab`,
		input: z.object({ message: z.string().min(1).describe('The commit message: what changed, and why') }),
		action: ({ message }, context) => pushCheckout(repository, message, stubs.pushBundle, context),
	})
}
