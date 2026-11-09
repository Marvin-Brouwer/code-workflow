import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { HostToolContext } from '@mesh-flow/gateway'
import { runGit } from '../git-process.mts'
import { splitRepositoryName } from '../repository-name.mts'
import { tokenCredential } from './api.mts'

/** Where the host clones live and how it reaches GitHub over git. */
export interface GitRemoteOptions {
	/** The connector's own directory: one bare clone per repository goes in it. */
	readonly directory: string
	/** The URL to clone `owner/name` from. Default: GitHub over HTTPS. */
	readonly remoteUrl?: (repository: string) => string
}

/** A repository's clone on the host, kept between calls, that pushes and fetches with the credential. */
export interface GitRemote {
	/**
	 * Fetches every branch of the repository into its clone, then writes a bundle with the default
	 * branch and `branch`, when the latter exists. Resolves to the bundle and what it holds.
	 */
	readonly fetchBundle: (
		repository: string,
		branch: string,
		context: HostToolContext,
	) => Promise<{ bundle: Buffer; defaultBranch: string; branchExists: boolean }>
	/** Takes `branch` from a bundle the sandbox made into the clone and pushes it. Resolves to the branch's commit. */
	readonly pushBundle: (repository: string, branch: string, bundle: Buffer, context: HostToolContext) => Promise<string>
}

/** The name of the remote in every clone. */
const origin = 'origin'

/** The refspec that keeps the clone's branches equal to the remote's: a mirror, without a checkout. */
const mirrorRefspec = '+refs/heads/*:refs/heads/*'

function githubRemoteUrl(repository: string): string {
	return `https://github.com/${repository}.git`
}

/** Clones on the host for every repository, under `options.directory`. */
export function gitRemote(options: GitRemoteOptions): GitRemote {
	const remoteUrl = options.remoteUrl ?? githubRemoteUrl
	const cloneOf = (repository: string) => {
		const { owner, repo } = splitRepositoryName(repository)
		return path.join(options.directory, owner, `${repo}.git`)
	}

	/** The clone of `repository`, made when missing, with the remote set to where it clones from. */
	const openClone = async (repository: string, context: HostToolContext): Promise<string> => {
		const clone = cloneOf(repository)
		await mkdir(clone, { recursive: true, mode: 0o700 })
		await git(clone, ['init', '--bare', '--quiet'], context)
		const url = remoteUrl(repository)
		const remotes = await git(clone, ['remote'], context)
		await git(clone, remotes.includes(origin) ? ['remote', 'set-url', origin, url] : ['remote', 'add', origin, url], context)
		return clone
	}

	return Object.freeze<GitRemote>({
		async fetchBundle(repository, branch, context) {
			const clone = await openClone(repository, context)
			await git(clone, ['fetch', '--quiet', '--prune', origin, mirrorRefspec], context)
			await git(clone, ['remote', 'set-head', origin, '--auto'], context)
			const defaultBranch = await defaultBranchOf(clone, context)
			const exists = branch !== defaultBranch && (await branchExists(clone, branch, context))
			const refs = exists ? [defaultBranch, branch] : [defaultBranch]
			const bundle = await withScratchFile(async (file) => {
				await git(clone, ['bundle', 'create', '--quiet', file, ...refs], context)
				return readFile(file)
			})
			return { bundle, defaultBranch, branchExists: exists || branch === defaultBranch }
		},
		async pushBundle(repository, branch, bundle, context) {
			const clone = await openClone(repository, context)
			await withScratchFile(async (file) => {
				await writeFile(file, bundle)
				await git(clone, ['fetch', '--quiet', file, `+refs/heads/${branch}:refs/heads/${branch}`], context)
			})
			await git(clone, ['push', '--quiet', origin, `refs/heads/${branch}:refs/heads/${branch}`], context)
			return (await git(clone, ['rev-parse', `refs/heads/${branch}`], context)).trim()
		},
	})
}

/**
 * Runs git with the token in the request headers, through the environment, so it never shows in
 * a process list. Aborting the context kills the process.
 */
async function git(clone: string, args: readonly string[], context: HostToolContext): Promise<string> {
	const token = await context.credentials.get(tokenCredential, context.abortSignal)
	if (token === undefined) throw new Error(`There is no GitHub token. Set it with \`mesh-flow credential set ${tokenCredential}\`.`)
	const authorization = Buffer.from(`x-access-token:${token}`).toString('base64')
	return runGit(
		clone,
		args,
		{
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: 'http.extraHeader',
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
			GIT_CONFIG_KEY_1: 'credential.helper',
			GIT_CONFIG_VALUE_1: '',
		},
		context.abortSignal,
	)
}

/** The remote's default branch, as `remote set-head --auto` recorded it. */
async function defaultBranchOf(clone: string, context: HostToolContext): Promise<string> {
	const head = await git(clone, ['symbolic-ref', `refs/remotes/${origin}/HEAD`], context)
	return head.trim().replace(`refs/remotes/${origin}/`, '')
}

function branchExists(clone: string, branch: string, context: HostToolContext): Promise<boolean> {
	return git(clone, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], context).then(
		() => true,
		() => false,
	)
}

/** Runs `use` with a file path in a fresh directory, removed afterwards. */
async function withScratchFile<T>(use: (file: string) => Promise<T>): Promise<T> {
	const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-github-'))
	try {
		return await use(path.join(scratch, 'commits.bundle'))
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}
