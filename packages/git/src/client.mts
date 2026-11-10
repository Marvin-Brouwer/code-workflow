import { commands, formatCommand, type Commands } from './commands.mts'
import { gitCommand, type GitCommand, type GitCommandOptions } from './command.mts'

/** What `gitClient` takes. */
export interface GitClientOptions {
	/** The repository, or the directory a `clone` or `init` makes one in. */
	readonly cwd: string
	/** Git config for every command, as `-c key=value`, such as `{ 'user.name': 'mesh-flow' }`. Never written to `.git/config`. */
	readonly gitConfig?: Readonly<Record<string, string>>
	/** On top of the process's environment, for every command, such as `basicAuthHeaderEnv(...)` for a credential. */
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
export type RawGit = {
	readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => string
}

/** A git repository to work in: every command, and the questions a workflow asks about a checkout. */
export interface GitClient extends ClientCommands {
	/** The repository the client works in. */
	readonly cwd: string
	/** Whether `ref` names a commit: a branch, a tag, `HEAD`, or `refs/remotes/origin/main`. */
	readonly hasRef: (ref: string) => Promise<boolean>
	/** Whether there is a local branch `name`. */
	readonly hasLocalBranch: (name: string) => Promise<boolean>
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
	/**
	 * Goes to branch `name`: as it is when there is a local one, else from `from`. Without `from`,
	 * from `origin/<name>` when the remote has the branch, so a rerun picks up the work already
	 * pushed, and from `origin/<default branch>` when it doesn't.
	 */
	readonly checkoutOrCreate: (name: string, from?: string) => Promise<void>
	/** Whether tracked files have changes against HEAD, staged or not, in `paths` or anywhere. Untracked files don't count. */
	readonly hasChanges: (...paths: string[]) => Promise<boolean>
	/**
	 * One `XY path` entry per path that makes the working tree dirty, as `git status --porcelain=v1`
	 * has it, such as ` M src/app.ts` or `?? notes.txt`: tracked changes and untracked files alike.
	 * The path is never quoted, whatever characters it has; a rename gives its new path.
	 */
	readonly dirtyFiles: () => Promise<readonly string[]>
	/** The paths with unresolved conflicts, never quoted. */
	readonly conflictedFiles: () => Promise<readonly string[]>
	/**
	 * Puts tracked files in `paths` back as they are at HEAD, in the index and the working tree,
	 * or every tracked file when no paths are given. Untracked files stay.
	 */
	readonly discardChanges: (...paths: string[]) => Promise<void>
	/** Writes the committer to `.git/config`; `gitConfig` in the options does it per command instead. */
	readonly setIdentity: (name: string, email: string) => Promise<void>
}

/** The git config this platform needs, before the caller's. */
const platformConfig: Readonly<Record<string, string>> =
	// Windows stops at 260 characters in a path unless git is told otherwise; a deep tree in a checkout gets there.
	process.platform === 'win32' ? { 'core.longpaths': 'true' } : {}

/** The name of the remote a clone gets. */
const defaultRemote = 'origin'

/** The branches a remote usually starts from, probed in this order when it didn't say. */
const usualDefaultBranches = ['main', 'master'] as const

/** The entries of NUL-terminated output, such as `-z` gives. */
function entries(output: string): string[] {
	return output.split('\0').filter((entry) => entry !== '')
}

/** `status -z` entries as `XY path`, without the original path a rename or a copy adds as an entry of its own. */
function statusEntries(output: string): string[] {
	const all = entries(output)
	const kept: string[] = []
	for (let index = 0; index < all.length; index++) {
		const entry = all[index] ?? ''
		kept.push(entry)
		if (renamedOrCopied.test(entry)) index++
	}
	return kept
}

/** A status entry whose path is followed by the path it came from. */
const renamedOrCopied = /^[RC]|^.[RC]/

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
export const rawGit: RawGit = Object.freeze(eachCommand(formatCommand))

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
	const hasLocalBranch = (name: string) => hasRef(`refs/heads/${name}`)
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
		hasLocalBranch,
		hasRemoteBranch,
		defaultBranch,
		currentBranch: async () => (await client.revParse('--abbrev-ref', 'HEAD')).stdout.trim(),
		checkoutOrCreate: async (name, from) => {
			if (await hasLocalBranch(name)) {
				await client.checkout(name, { quiet: true })
				return
			}
			const start = from ?? `${defaultRemote}/${(await hasRemoteBranch(name)) ? name : await defaultBranch()}`
			await client.checkout(name, { create: true, from: start, quiet: true })
		},
		hasChanges: async (...paths) => (await client.status({ untracked: false, nulTerminated: true, paths })).stdout !== '',
		dirtyFiles: async () => statusEntries((await client.status({ nulTerminated: true })).stdout),
		conflictedFiles: async () => entries((await client.diff('--name-only', '--diff-filter=U', '-z')).stdout),
		discardChanges: async (...paths) => {
			if (paths.length === 0) await client.reset({ mode: 'hard', quiet: true })
			else await client.restore(paths, { source: 'HEAD', staged: true, worktree: true })
		},
		setIdentity: async (name, email) => {
			await client.config('user.name', name)
			await client.config('user.email', email)
		},
	})
}
