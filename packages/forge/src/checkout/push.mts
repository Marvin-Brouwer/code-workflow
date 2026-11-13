import { readFile } from 'node:fs/promises'
import type { ToolContext } from '@mesh-flow/core'
import { withScratchFile } from '../scratch-file.mts'
import type { Checkout } from './checkout.mts'
import { localGit } from './local-git.mts'
import { trackingRef } from './tracking.mts'

/** What a push did. */
export interface Pushed {
	/** Whether anything went up: `false` when the branch was already pushed. */
	readonly pushed: boolean
	/** The branch's commit on the forge. */
	readonly head: string
}

/** The host tool that pushes a bundle to a branch and resolves to the branch's commit. */
export type PushBundle = (input: { repository: string; branch: string; bundle: string }, context: ToolContext) => Promise<{ head: string }>

/**
 * Commits every change in the checkout with `message` and pushes the branch. The commits go to the
 * host as a git bundle of what the remote doesn't have yet (on top of the default branch for a new
 * branch), and the host pushes them with the credential.
 */
export async function pushCheckout(repository: Checkout, message: string, pushBundle: PushBundle, context: ToolContext): Promise<Pushed> {
	const { directory, branch, defaultBranch } = repository
	const git = localGit(directory, context.abortSignal)
	if ((await git.dirtyFiles()).length > 0) {
		await git.add()
		await git.commit({ message, quiet: true })
	}
	const head = (await git.revParse('HEAD')).stdout.trim()
	const tracking = trackingRef(branch)
	const tracked = await git.hasRef(tracking)
	if (tracked && (await git.revParse(tracking)).stdout.trim() === head) return { pushed: false, head }
	// A new branch is bundled on top of the default branch, which the host has: never the whole history.
	const base = tracked ? tracking : trackingRef(defaultBranch)
	const range = (await git.hasRef(base)) ? `${base}..${branch}` : branch
	return withScratchFile('push.bundle', async (file) => {
		await git.bundleCreate(file, [range], { quiet: true })
		const bundle = (await readFile(file)).toString('base64')
		const result = await pushBundle({ repository: repository.name, branch, bundle }, context)
		await git.updateRef(tracking, result.head)
		return { pushed: true, head: result.head }
	})
}

/**
 * Which commit a checkout's branch is at: the checkout's `HEAD`, or with `pushed` the branch as it
 * was last pushed, which is what an open pull or merge request shows.
 */
export async function branchHeadOf(repository: Checkout, pushed: boolean, context: ToolContext): Promise<string> {
	const git = localGit(repository.directory, context.abortSignal)
	const tracking = trackingRef(repository.branch)
	const head = pushed && (await git.hasRef(tracking)) ? tracking : 'HEAD'
	return (await git.revParse(head)).stdout.trim()
}
