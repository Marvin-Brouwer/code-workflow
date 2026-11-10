import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HostToolContext } from '@mesh-flow/gateway'
import { runGit } from '../git-process.mts'
import { githubRemoteUrl, splitRepositoryName } from '../repository-name.mts'
import { withScratchFile } from '../scratch-file.mts'
import { requireToken } from './api.mts'

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
	/**
	 * Takes `branch` from a bundle the sandbox made into the clone and pushes it. Resolves to the
	 * branch's commit, which is the bundle's head; anything else fails the call.
	 */
	readonly pushBundle: (repository: string, branch: string, bundle: Buffer, context: HostToolContext) => Promise<string>
}

/** The name of the remote in every clone. */
const origin = 'origin'

/** The refspec that keeps the clone's branches equal to the remote's: a mirror, without a checkout. */
const mirrorRefspec = '+refs/heads/*:refs/heads/*'

/** Clones on the host for every repository, under `options.directory`. */
export function gitRemote(options: GitRemoteOptions): GitRemote {
	const remoteUrl = options.remoteUrl ?? githubRemoteUrl
	const cloneOf = (repository: string) => {
		const { owner, repo } = splitRepositoryName(repository)
		return path.join(options.directory, owner, `${repo}.git`)
	}

	/**
	 * One call at a time per clone: runs from different workflows share a repository's clone, and a
	 * mirror fetch in the middle of a push would reset the branch the push is about to send.
	 */
	const lastOn = new Map<string, Promise<unknown>>()
	async function withClone<T>(repository: string, context: HostToolContext, use: (clone: string) => Promise<T>): Promise<T> {
		const clone = cloneOf(repository)
		const turn = (lastOn.get(clone) ?? Promise.resolve()).then(
			() => openClone(clone, repository, context).then(use),
			() => openClone(clone, repository, context).then(use),
		)
		lastOn.set(clone, turn)
		try {
			return await turn
		} finally {
			if (lastOn.get(clone) === turn) lastOn.delete(clone)
		}
	}

	/** Makes the clone when missing, and sets the remote to where it clones from. */
	const openClone = async (clone: string, repository: string, context: HostToolContext): Promise<string> => {
		await mkdir(clone, { recursive: true, mode: 0o700 })
		await git(clone, ['init', '--bare', '--quiet'], context)
		const url = remoteUrl(repository)
		const remotes = await git(clone, ['remote'], context)
		await git(clone, remotes.includes(origin) ? ['remote', 'set-url', origin, url] : ['remote', 'add', origin, url], context)
		return clone
	}

	return Object.freeze<GitRemote>({
		fetchBundle: (repository, branch, context) =>
			withClone(repository, context, async (clone) => {
				await mirror(clone, context)
				await git(clone, ['remote', 'set-head', origin, '--auto'], context)
				const defaultBranch = await defaultBranchOf(clone, context)
				const exists = branch !== defaultBranch && (await branchExists(clone, branch, context))
				const refs = exists ? [defaultBranch, branch] : [defaultBranch]
				const bundle = await withScratchFile('clone.bundle', async (file) => {
					await git(clone, ['bundle', 'create', '--quiet', file, ...refs], context)
					return readFile(file)
				})
				return { bundle, defaultBranch, branchExists: exists || branch === defaultBranch }
			}),
		pushBundle: (repository, branch, bundle, context) =>
			withClone(repository, context, async (clone) => {
				// The bundle holds only what the sandbox's checkout had not pushed yet, so the clone needs the rest first.
				await mirror(clone, context)
				const head = await withScratchFile('push.bundle', async (file) => {
					await writeFile(file, bundle)
					const expected = await bundleHead(clone, file, branch, context)
					await git(clone, ['fetch', '--quiet', file, `+refs/heads/${branch}:refs/heads/${branch}`], context)
					return expected
				})
				await git(clone, ['push', '--quiet', origin, `refs/heads/${branch}:refs/heads/${branch}`], context)
				const pushed = (await git(clone, ['rev-parse', `refs/heads/${branch}`], context)).trim()
				if (pushed !== head) throw new Error(`Pushing ${branch} of ${repository} left it at ${pushed}, not at the bundle's ${head}.`)
				return pushed
			}),
	})
}

/**
 * Runs git with the token in the request headers, through the environment, so it never shows in
 * a process list. Aborting the context kills the process.
 */
async function git(clone: string, args: readonly string[], context: HostToolContext): Promise<string> {
	const authorization = Buffer.from(`x-access-token:${await requireToken(context)}`).toString('base64')
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

/** Makes the clone's branches equal to the remote's. */
function mirror(clone: string, context: HostToolContext): Promise<string> {
	return git(clone, ['fetch', '--quiet', '--prune', origin, mirrorRefspec], context)
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

/** The commit a bundle says `branch` is at. */
async function bundleHead(clone: string, file: string, branch: string, context: HostToolContext): Promise<string> {
	const heads = await git(clone, ['bundle', 'list-heads', file, `refs/heads/${branch}`], context)
	const [sha] = heads.trim().split(/\s+/)
	if (sha === undefined || sha === '') throw new Error(`The bundle holds no ${branch}.`)
	return sha
}
