import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool, toPrompt, workspace } from '@mesh-flow/core'
import type { GitClient } from '@mesh-flow/git'
import { z } from 'zod'
import { BranchName, githubRemoteUrl, RepositoryName, splitRepositoryName } from '../repository-name.mts'
import { withScratchFile } from '../scratch-file.mts'
import { stubs } from '../stubs.mts'
import { localGit } from './local-git.mts'

/** A checkout of a GitHub repository in the workspace, on a branch. In a prompt it renders as its path. */
export interface Repository {
	/** `owner/name`. */
	readonly name: RepositoryName
	readonly branch: BranchName
	readonly defaultBranch: BranchName
	/** The checkout, relative to the workspace. */
	readonly path: string
	/** The checkout on disk. */
	readonly directory: string
	[toPrompt](): string
}

/** The remote the sandbox's checkout knows: a ref under it tracks what the host has pushed. */
export const origin = 'origin'

/** Where the checkout remembers the remote's default branch, so a reused checkout needs no host call. */
const defaultBranchConfigKey = 'mesh-flow.defaultBranch'

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
	action: async ({ repository, branch }, { abortSignal }): Promise<Repository> => {
		const folder = workspace.folder(splitRepositoryName(repository).repo)
		const directory = folder.location()
		const git = localGit(directory, abortSignal)
		const existing = await existingCheckout(git)
		if (existing === 'other') throw new Error(`${folder.path} holds something that isn't a checkout, so ${repository} can't go there.`)
		if (existing === 'broken') await rm(directory, { recursive: true, force: true })
		if (existing === 'checkout') {
			const url = (await git.remoteGetUrl(origin)).stdout.trim()
			if (url !== githubRemoteUrl(repository))
				throw new Error(`${folder.path} holds a checkout of another repository (${url}), so ${repository} can't go there.`)
			const defaultBranch = (await git.config(defaultBranchConfigKey)).stdout.trim()
			await switchTo(git, branch, defaultBranch)
			return repositoryOf(repository, branch, defaultBranch, folder.path, directory)
		}
		const fetched = await stubs.cloneRepository({ repository, branch }, { abortSignal })
		await withScratchFile('clone.bundle', async (bundle) => {
			await writeFile(bundle, Buffer.from(fetched.bundle, 'base64'))
			const from = fetched.branchExists ? branch : fetched.defaultBranch
			await localGit(path.dirname(directory), abortSignal).clone(bundle, directory, { branch: from, quiet: true })
		})
		if (!fetched.branchExists) await git.checkout(branch, { create: true, quiet: true })
		// The bundle is gone: the remote is only where the pushed state is tracked, under refs/remotes/origin.
		await git.remoteSetUrl(origin, githubRemoteUrl(repository))
		await git.config(defaultBranchConfigKey, fetched.defaultBranch)
		return repositoryOf(repository, branch, fetched.defaultBranch, folder.path, directory)
	},
})

function repositoryOf(name: string, branch: string, defaultBranch: string, folderPath: string, directory: string): Repository {
	return Object.freeze({ name, branch, defaultBranch, path: folderPath, directory, [toPrompt]: () => folderPath })
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
	const tracked = `refs/remotes/${origin}/${branch}`
	const from = (await git.hasRef(tracked)) ? tracked : `refs/remotes/${origin}/${defaultBranch}`
	await git.checkoutOrCreate(branch, from)
}
