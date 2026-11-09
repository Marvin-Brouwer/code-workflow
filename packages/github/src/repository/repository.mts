import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tool, toPrompt, workspace } from '@mesh-flow/core'
import { z } from 'zod'
import { BranchName, RepositoryName, splitRepositoryName } from '../repository-name.mts'
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

/**
 * Checks a repository out into the workspace, on `branch`, which is made from the default branch
 * when GitHub doesn't have it yet. The clone comes from the host as a git bundle, so no credential
 * reaches the sandbox; a checkout that is already there is reused.
 *
 * ```ts
 * const repository = await github.checkout('team/app', { branch: `fix/${String(issue.number)}` })
 * await developer.loop`Fix ${issue} in ${repository}, then push with ${github.push(repository)}.`
 * ```
 */
export const checkout = tool('githubCheckout', {
	description: 'Checks a GitHub repository out into the workspace, on a branch',
	input: z.object({ repository: RepositoryName, branch: BranchName }),
	action: async ({ repository, branch }, { abortSignal }): Promise<Repository> => {
		const folder = workspace.folder(splitRepositoryName(repository).repo)
		const directory = folder.location()
		if (await isCheckout(directory)) {
			const defaultBranch = (await localGit(directory, ['config', '--get', 'mesh-flow.defaultBranch'], abortSignal)).trim()
			return repositoryOf(repository, branch, defaultBranch, folder.path, directory)
		}
		const fetched = await stubs.cloneRepository({ repository, branch }, { abortSignal })
		const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-github-'))
		try {
			const bundle = path.join(scratch, 'clone.bundle')
			await writeFile(bundle, Buffer.from(fetched.bundle, 'base64'))
			const from = fetched.branchExists ? branch : fetched.defaultBranch
			await localGit(path.dirname(directory), ['clone', '--quiet', '--branch', from, bundle, directory], abortSignal)
		} finally {
			await rm(scratch, { recursive: true, force: true })
		}
		if (!fetched.branchExists) await localGit(directory, ['checkout', '--quiet', '-b', branch], abortSignal)
		// The bundle is gone: the remote is only where the pushed state is tracked, under refs/remotes/origin.
		await localGit(directory, ['remote', 'set-url', origin, `https://github.com/${repository}.git`], abortSignal)
		await localGit(directory, ['config', 'mesh-flow.defaultBranch', fetched.defaultBranch], abortSignal)
		return repositoryOf(repository, branch, fetched.defaultBranch, folder.path, directory)
	},
})

function repositoryOf(name: string, branch: string, defaultBranch: string, folderPath: string, directory: string): Repository {
	return Object.freeze({ name, branch, defaultBranch, path: folderPath, directory, [toPrompt]: () => folderPath })
}

async function isCheckout(directory: string): Promise<boolean> {
	return stat(path.join(directory, '.git')).then(
		(found) => found.isDirectory(),
		() => false,
	)
}
