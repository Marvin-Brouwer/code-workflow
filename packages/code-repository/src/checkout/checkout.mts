import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import type { GitClient } from '@mesh-flow/git'
import { withScratchFile } from '../scratch-file.mts'
import { localGit } from './local-git.mts'
import { origin, trackingRef } from './tracking.mts'

/**
 * A checkout of a code host's repository in the workspace, on a branch. In a prompt it renders as
 * where it is on disk, so the agent finds it from any directory, including inside another checkout.
 */
export interface Checkout {
	/** The repository as the code host names it, such as `owner/name` or `group/project`. */
	readonly name: string
	readonly branch: string
	readonly defaultBranch: string
	/** The checkout, relative to the workspace. */
	readonly path: string
	/** The checkout on disk. */
	readonly directory: string
	[toPrompt](): string
}

/** What a clone on the host gives the sandbox: the repository as a git bundle, base64, and what it holds. */
export interface ClonedBundle {
	readonly bundle: string
	readonly defaultBranch: string
	/** Whether the branch exists on the code host. When it doesn't, the bundle holds the default branch only. */
	readonly branchExists: boolean
}

/** What `checkoutRepository` takes. */
export interface CheckoutOptions {
	/** The repository as the code host names it. */
	readonly repository: string
	readonly branch: string
	/** The folder in the workspace the checkout goes in, such as the repository's own name. */
	readonly folder: string
	/**
	 * What the checkout's `origin` is set to, and what a reused checkout's has to be: the repository's
	 * URL, or a name that stands for it. The sandbox never fetches from it: clones and pushes go
	 * through the host.
	 */
	readonly remote: string
	/** The host tool that clones the repository and hands it over as a bundle. */
	readonly clone: (input: { repository: string; branch: string }, context: ToolContext) => Promise<ClonedBundle>
}

/** Where the checkout remembers the remote's default branch, so a reused checkout needs no host call. */
const defaultBranchConfigKey = 'mesh-flow.defaultBranch'

/**
 * Checks a repository out into the workspace, on `branch`, which is made from the default branch
 * when the code host doesn't have it yet. The clone comes from the host as a git bundle, so no
 * credential reaches the sandbox. A checkout of the repository that is already there is reused,
 * switched to `branch` when it is on another; a folder left half-cloned is cloned again, and a
 * folder of the workflow's own that is no checkout is left alone, with an error.
 */
export async function checkoutRepository(options: CheckoutOptions, context: ToolContext): Promise<Checkout> {
	const { repository, branch } = options
	const { abortSignal } = context
	const folder = workspace.folder(options.folder)
	const directory = folder.location()
	const git = localGit(directory, abortSignal)
	const existing = await existingCheckout(git)
	if (existing === 'other') throw new Error(`${folder.path} holds something that isn't a checkout, so ${repository} can't go there.`)
	if (existing === 'broken') await rm(directory, { recursive: true, force: true })
	if (existing === 'checkout') {
		const url = (await git.remoteGetUrl(origin)).stdout.trim()
		// Code hosts ignore case in names: a checkout made under another case is one of the same repository.
		if (url.toLowerCase() !== options.remote.toLowerCase())
			throw new Error(`${folder.path} holds a checkout of another repository (${url}), so ${repository} can't go there.`)
		if (url !== options.remote) await git.remoteSetUrl(origin, options.remote)
		const defaultBranch = (await git.config(defaultBranchConfigKey)).stdout.trim()
		await switchTo(git, branch, defaultBranch)
		return checkoutOf(repository, branch, defaultBranch, folder.path, directory)
	}
	const fetched = await options.clone({ repository, branch }, context)
	await withScratchFile('clone.bundle', async (bundle) => {
		await writeFile(bundle, Buffer.from(fetched.bundle, 'base64'))
		const from = fetched.branchExists ? branch : fetched.defaultBranch
		await localGit(path.dirname(directory), abortSignal).clone(bundle, directory, { branch: from, quiet: true })
	})
	if (!fetched.branchExists) await git.checkout(branch, { create: true, quiet: true })
	// The bundle is gone: the remote is only where the pushed state is tracked, under refs/remotes/origin.
	await git.remoteSetUrl(origin, options.remote)
	await git.config(defaultBranchConfigKey, fetched.defaultBranch)
	return checkoutOf(repository, branch, fetched.defaultBranch, folder.path, directory)
}

function checkoutOf(name: string, branch: string, defaultBranch: string, folderPath: string, directory: string): Checkout {
	return Object.freeze({ name, branch, defaultBranch, path: folderPath, directory, [toPrompt]: () => directory })
}

/**
 * What is in the folder: nothing, a checkout git can work in, the remains of a clone it can't, or
 * something else of the workflow's, which is never touched.
 */
async function existingCheckout(git: GitClient): Promise<'absent' | 'checkout' | 'broken' | 'other'> {
	const present = await stat(git.cwd).then(
		() => true,
		() => false,
	)
	if (!present) return 'absent'
	const hasGitDirectory = await stat(path.join(git.cwd, '.git')).then(
		() => true,
		() => false,
	)
	if (!hasGitDirectory) return 'other'
	// `.git` as git names it: the folder is a repository of its own, not a folder in some other one.
	const gitDirectory = await git.revParse('--git-dir').run()
	const works = gitDirectory.ok && gitDirectory.stdout.trim() === '.git'
	return works && (await git.hasRef('HEAD')) ? 'checkout' : 'broken'
}

/** Puts the checkout on `branch`: as it is when it's there, made from what the remote has otherwise. */
async function switchTo(git: GitClient, branch: string, defaultBranch: string): Promise<void> {
	if ((await git.currentBranch()) === branch) return
	const tracked = trackingRef(branch)
	const from = (await git.hasRef(tracked)) ? tracked : trackingRef(defaultBranch)
	await git.checkoutOrCreate(branch, from)
}
