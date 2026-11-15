import { pushCheckout, type Pushed } from '@mesh-flow/code-repository'
import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import type { Repository } from './repository.mts'

export type { Pushed }

/**
 * The tool that commits every change in the checkout and pushes the branch, for an agent to call
 * when its work is ready, and for code before a pull request. The commits go to the host as a git
 * bundle of what the remote doesn't have yet (on top of the default branch for a new branch), and
 * the host pushes them with the credential.
 *
 * A checkout without changes since the last push pushes nothing, so calling it again is safe.
 *
 * @param repository - The checkout to push, from `github.checkout`.
 * @returns The tool. Its input is `{ message }`, the commit message; it resolves to `{ pushed, head }`:
 * whether anything went up, and the branch's commit on GitHub.
 *
 * The tool throws when the branch has no commits on top of the default branch, as there is nothing
 * to push, and when GitHub turns the push down, such as for a protected branch.
 *
 * @example For an agent
 * ```ts
 * await developer.loop`Fix ${issue} in ${repository}. Push with ${github.push(repository)}, then ${succeed()}.`
 * ```
 *
 * @example From code
 * ```ts
 * await writeFile(path.join(repository.directory, '.nvmrc'), '26\n')
 * const { head } = await github.push(repository)({ message: 'Run on Node.js 26' })
 * ```
 */
export function push(repository: Repository): Tool<{ message: string }, Pushed> {
	return tool('push', {
		description: `Commits every change in ${repository.directory} with the message and pushes the branch to GitHub`,
		input: z.object({ message: z.string().min(1).describe('The commit message: what changed, and why') }),
		action: ({ message }, context) => pushCheckout(repository, message, stubs.pushBundle, context),
	})
}
