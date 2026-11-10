import { commands, formatCommand, type Commands } from './commands.mts'
import { gitCommand, type GitCommand, type GitCommandOptions } from './command.mts'

/** What `gitClient` takes. */
export interface GitClientOptions {
	/** The repository, or the directory a `clone` or `init` makes one in. */
	readonly cwd: string
	/** Git config for every command, as `-c key=value`, such as `{ 'user.name': 'mesh-flow' }`. Never written to `.git/config`. */
	readonly gitConfig?: Readonly<Record<string, string>>
	/** On top of the process's environment, for every command: an authorization header through `GIT_CONFIG_*`, for one. */
	readonly env?: Readonly<Record<string, string>>
	/**
	 * When aborted, every git invocation this client spawns is killed, and the call rejects with
	 * the signal's reason. One place for cancellation: callers give the signal once, here, not at
	 * every call. `.attempt()` still swallows the result, so a stop during best-effort cleanup is
	 * harmless.
	 */
	readonly abortSignal: AbortSignal
}

/** Each command of {@link commands}, as a {@link GitCommand} the client runs or renders. */
export type ClientCommands = {
	readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => GitCommand
}

/** Each command of {@link commands}, rendered as a shell line. Nothing runs. */
export type RawGitClient = {
	readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => string
}

/** A git repository to work in: every command, and the questions a workflow asks about a checkout. */
export interface GitClient extends ClientCommands {
	readonly cwd: string
	/** Whether `ref` names a commit: a branch, a tag, `HEAD`, or `refs/remotes/origin/main`. */
	readonly hasRef: (ref: string) => Promise<boolean>
	/** Whether there is a local branch `name`. */
	readonly hasBranch: (name: string) => Promise<boolean>
	/** Whether `remote` (default `origin`) has a branch `name` as far as the repository knows. */
	readonly hasRemoteBranch: (name: string, remote?: string) => Promise<boolean>
	/**
	 * The branch `remote` (default `origin`) starts from: what `refs/remotes/<remote>/HEAD` says
	 * when a clone or `remoteSetHead` recorded it, else `main` or `master`, whichever the remote
	 * has. Compose `origin/${await git.defaultBranch()}` for the tracking ref.
	 */
	readonly defaultBranch: (remote?: string) => Promise<string>
	/** The branch the working tree is on, or `HEAD` when it isn't on one. */
	readonly currentBranch: () => Promise<string>
	/** Goes to branch `name`: as it is when it's there, made from `from` (default `origin/<default branch>`) otherwise. */
	readonly checkoutOrCreate: (name: string, from?: string) => Promise<void>
	/** Whether the tracked files have changes against HEAD, in `paths` or anywhere. Untracked files don't count. */
	readonly hasChanges: (...paths: string[]) => Promise<boolean>
	/** The paths that make the working tree dirty, tracked changes and untracked files alike, as `git status --porcelain=v1` lines. */
	readonly dirtyFiles: () => Promise<readonly string[]>
	/** The paths with unresolved conflicts. */
	readonly conflictedFiles: () => Promise<readonly string[]>
	/** Takes the working tree's changes in `paths` back, all of them when none are given. */
	readonly discardChanges: (...paths: string[]) => Promise<void>
	/** Writes the committer to `.git/config`; `gitConfig` in the options does it per command instead. */
	readonly setIdentity: (name: string, email: string) => Promise<void>
}

/** The git config that applies on every platform, before the caller's. */
const platformConfig: Readonly<Record<string, string>> =
	// Windows stops at 260 characters in a path unless git is told otherwise; a deep tree in a checkout gets there.
	process.platform === 'win32' ? { 'core.longpaths': 'true' } : {}

/** The name of the remote a clone gets. */
const defaultRemote = 'origin'

/** The branches a remote usually starts from, probed in this order when it didn't say. */
const usualDefaultBranches = ['main', 'master'] as const

/** Git's output as its non-empty lines. */
function lines(output: string): string[] {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
}

/** Every command as a function of its arguments, each passing its arguments on as they are. */
function eachCommand<Made>(make: (args: readonly string[]) => Made): {
	readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => Made
} {
	const made = Object.fromEntries(
		Object.entries(commands).map(([name, build]) => [
			name,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each entry has its own parameters; here the arguments pass as they are
			(...args: unknown[]) => make((build as (...args: unknown[]) => string[])(...args)),
		]),
	)
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from `commands`, whose keys and parameters it mirrors
	return made as { readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => Made }
}

/**
 * Every command rendered as the shell line it would run, for a prompt or a log, without running:
 * `rawGit.rebase('origin/main')` is `'git rebase origin/main'`. A client renders the same way,
 * `String(git.rebase('origin/main'))`, so this is for code that has no client.
 */
export const rawGit: RawGitClient = Object.freeze(eachCommand(formatCommand))

/**
 * A client for the repository at `options.cwd`. Every command on it is a {@link GitCommand}:
 * awaited it runs and fails on a non-zero exit, `run()` hands the exit back, `attempt()` is best
 * effort, and in a template string it renders as the shell line.
 *
 * ```ts
 * const git = gitClient({ cwd: checkout, abortSignal })
 * await git.fetch('origin', ['main'])
 * await git.checkoutOrCreate('fix/7')
 * const { stdout } = await git.revParse('HEAD')
 * ```
 */
export function gitClient(options: GitClientOptions): GitClient {
	const commandOptions: GitCommandOptions = {
		cwd: options.cwd,
		abortSignal: options.abortSignal,
		prefix: Object.entries({ ...platformConfig, ...options.gitConfig }).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
		...(options.env === undefined ? {} : { env: options.env }),
	}
	const client = eachCommand((args) => gitCommand(args, commandOptions))

	const hasRef = async (ref: string) => (await client.revParse('--verify', '--quiet', ref).run()).ok
	const hasBranch = (name: string) => hasRef(`refs/heads/${name}`)
	const hasRemoteBranch = (name: string, remote = defaultRemote) => hasRef(`refs/remotes/${remote}/${name}`)
	const defaultBranch = async (remote = defaultRemote) => {
		const recorded = await client.symbolicRef(`refs/remotes/${remote}/HEAD`).run()
		if (recorded.ok) return recorded.stdout.trim().replace(`refs/remotes/${remote}/`, '')
		for (const name of usualDefaultBranches) if (await hasRemoteBranch(name, remote)) return name
		throw new Error(`Remote ${remote} has no default branch as far as the repository knows: fetch it first.`)
	}

	return Object.freeze<GitClient>({
		...client,
		cwd: options.cwd,
		hasRef,
		hasBranch,
		hasRemoteBranch,
		defaultBranch,
		currentBranch: async () => (await client.revParse('--abbrev-ref', 'HEAD')).stdout.trim(),
		checkoutOrCreate: async (name, from) => {
			if (await hasBranch(name)) await client.checkout(name, { quiet: true })
			else await client.checkout(name, { create: true, from: from ?? `${defaultRemote}/${await defaultBranch()}`, quiet: true })
		},
		hasChanges: async (...paths) => (await client.diff('--name-only', ...(paths.length > 0 ? ['--', ...paths] : []))).stdout.trim() !== '',
		dirtyFiles: async () => lines((await client.status()).stdout),
		conflictedFiles: async () => lines((await client.diff('--name-only', '--diff-filter=U')).stdout),
		discardChanges: async (...paths) => {
			await client.checkoutPaths(...paths)
		},
		setIdentity: async (name, email) => {
			await client.config('user.name', name)
			await client.config('user.email', email)
		},
	})
}
