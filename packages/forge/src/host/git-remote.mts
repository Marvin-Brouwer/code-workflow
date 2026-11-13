import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { oneAtATime, type HostToolContext } from '@mesh-flow/gateway'
import { gitClient, type GitClient } from '@mesh-flow/git'
import { withScratchFile } from '../scratch-file.mts'

/** Where the host clones live and how it reaches the forge over git. */
export interface GitRemoteOptions {
	/** The connector's own directory: one bare clone per repository goes in it. */
	readonly directory: string
	/** The URL to clone a repository from, by the name the forge gives it. */
	readonly remoteUrl: (repository: string, context: HostToolContext) => string | Promise<string>
	/**
	 * Where under `directory` a repository's clone goes, as path segments: one per part of its name,
	 * which the connector has checked, so none of them can leave `directory`.
	 */
	readonly cloneSegments: (repository: string) => readonly string[]
	/** Git's environment for a call, which carries the credential, such as `basicAuthHeaderEnv`. */
	readonly credentialEnv: (context: HostToolContext) => Promise<Readonly<Record<string, string>>>
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
	function cloneOf(repository: string): string {
		const segments = [...options.cloneSegments(repository)]
		const last = segments.pop()
		if (last === undefined) throw new Error(`${repository} names no clone.`)
		return path.join(options.directory, ...segments, `${last}.git`)
	}

	/**
	 * One call at a time per clone: runs from different workflows share a repository's clone, and a
	 * mirror fetch in the middle of a push would reset the branch the push is about to send.
	 */
	const onClone = oneAtATime()
	function withClone<T>(repository: string, context: HostToolContext, use: (git: GitClient) => Promise<T>): Promise<T> {
		const clone = cloneOf(repository)
		return onClone(clone, context.abortSignal, () => openClone(clone, repository, context).then(use))
	}

	/** Makes the clone when missing, and sets the remote to where it clones from. */
	async function openClone(clone: string, repository: string, context: HostToolContext): Promise<GitClient> {
		await mkdir(clone, { recursive: true, mode: 0o700 })
		// The credential travels as `GIT_CONFIG_*` environment, so it never shows in a process list.
		const git = gitClient({ cwd: clone, env: await options.credentialEnv(context), abortSignal: context.abortSignal })
		await git.init({ bare: true, quiet: true })
		const url = await options.remoteUrl(repository, context)
		const remotes = (await git.remotes()).stdout.split('\n').map((line) => line.trim())
		await (remotes.includes(origin) ? git.remoteSetUrl(origin, url) : git.remoteAdd(origin, url))
		return git
	}

	return Object.freeze<GitRemote>({
		fetchBundle: (repository, branch, context) =>
			withClone(repository, context, async (git) => {
				await mirror(git)
				await git.remoteSetHead(origin)
				const defaultBranch = await git.defaultBranch(origin)
				const exists = branch !== defaultBranch && (await git.hasLocalBranch(branch))
				const refs = exists ? [defaultBranch, branch] : [defaultBranch]
				const bundle = await withScratchFile('clone.bundle', async (file) => {
					await git.bundleCreate(file, refs, { quiet: true })
					return readFile(file)
				})
				return { bundle, defaultBranch, branchExists: exists || branch === defaultBranch }
			}),
		pushBundle: (repository, branch, bundle, context) =>
			withClone(repository, context, async (git) => {
				// The bundle holds only what the sandbox's checkout had not pushed yet, so the clone needs the rest first.
				await mirror(git)
				const head = await withScratchFile('push.bundle', async (file) => {
					await writeFile(file, bundle)
					const expected = await bundleHead(git, file, branch)
					await git.fetch(file, [`+refs/heads/${branch}:refs/heads/${branch}`], { quiet: true })
					return expected
				})
				await git.push(origin, [`refs/heads/${branch}:refs/heads/${branch}`], { quiet: true })
				const pushed = (await git.revParse(`refs/heads/${branch}`)).stdout.trim()
				if (pushed !== head) throw new Error(`Pushing ${branch} of ${repository} left it at ${pushed}, not at the bundle's ${head}.`)
				return pushed
			}),
	})
}

/** Makes the clone's branches equal to the remote's. */
async function mirror(git: GitClient): Promise<void> {
	await git.fetch(origin, [mirrorRefspec], { prune: true, quiet: true })
}

/** The commit a bundle says `branch` is at. */
async function bundleHead(git: GitClient, file: string, branch: string): Promise<string> {
	const heads = await git.bundleListHeads(file, `refs/heads/${branch}`)
	const [sha] = heads.stdout.trim().split(/\s+/)
	if (sha === undefined || sha === '') throw new Error(`The bundle holds no ${branch}.`)
	return sha
}
