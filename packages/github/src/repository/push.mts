import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tool, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import { hasRef, localGit } from './local-git.mts'
import { origin, type Repository } from './repository.mts'

/** What a push did. */
export interface Pushed {
	/** Whether anything went up: `false` when the branch was already pushed. */
	readonly pushed: boolean
	/** The branch's commit on GitHub. */
	readonly head: string
}

/**
 * The tool that commits every change in the checkout and pushes the branch, for an agent to call
 * when its work is ready, and for code before a pull request. The commits go to the host as a git
 * bundle of what the remote doesn't have yet, and the host pushes them with the credential.
 *
 * ```ts
 * await developer.loop`Fix ${issue} in ${repository}. Push with ${github.push(repository)}, then ${succeed()}.`
 * ```
 */
export function push(repository: Repository): Tool<{ message: string }, Pushed> {
	return tool('push', {
		description: `Commits every change in ${repository.path} with the message and pushes the branch to GitHub`,
		input: z.object({ message: z.string().min(1).describe('The commit message') }),
		action: async ({ message }, { abortSignal }): Promise<Pushed> => {
			const { directory, branch } = repository
			const status = await localGit(directory, ['status', '--porcelain'], abortSignal)
			if (status.trim() !== '') {
				await localGit(directory, ['add', '--all'], abortSignal)
				await localGit(directory, ['commit', '--quiet', '--message', message], abortSignal)
			}
			const head = (await localGit(directory, ['rev-parse', 'HEAD'], abortSignal)).trim()
			const tracking = `refs/remotes/${origin}/${branch}`
			const base = (await hasRef(directory, tracking, abortSignal))
				? (await localGit(directory, ['rev-parse', tracking], abortSignal)).trim()
				: undefined
			if (base === head) return { pushed: false, head }
			const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-github-'))
			try {
				const file = path.join(scratch, 'push.bundle')
				const range = base === undefined ? branch : `${tracking}..${branch}`
				await localGit(directory, ['bundle', 'create', '--quiet', file, range], abortSignal)
				const bundle = (await readFile(file)).toString('base64')
				const result = await stubs.pushBundle({ repository: repository.name, branch, bundle }, { abortSignal })
				await localGit(directory, ['update-ref', tracking, result.head], abortSignal)
				return { pushed: true, head: result.head }
			} finally {
				await rm(scratch, { recursive: true, force: true })
			}
		},
	})
}
