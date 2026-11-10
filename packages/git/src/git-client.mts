import { commands, type Commands } from './commands.mts'
import { gitCommand, type GitCommand, type GitCommandOptions } from './git-command.mts'

/** What `gitClient` takes. */
export interface GitClientOptions {
	/** The repository, or the directory a `clone` or `init` makes one in. */
	readonly cwd: string
	/** Git config for every command, as `-c key=value`, such as `{ 'user.name': 'mesh-flow' }`. Never written to `.git/config`. */
	readonly config?: Readonly<Record<string, string>>
	/** On top of the process's environment, for every command: an authorization header through `GIT_CONFIG_*`, for one. */
	readonly env?: Readonly<Record<string, string>>
	/** Aborting it kills whatever command runs and rejects it with the signal's reason. */
	readonly abortSignal: AbortSignal
}

/** Each command of {@link commands}, as a {@link GitCommand} the client runs or renders. */
export type ClientCommands = {
	readonly [Name in keyof Commands]: (...args: Parameters<Commands[Name]>) => GitCommand
}

/** A git repository to work in: every command, and a few questions git answers with an exit code. */
export interface GitClient extends ClientCommands {
	readonly cwd: string
	/** Whether `ref` names a commit: a branch, a tag, `HEAD`, or `refs/remotes/origin/main`. */
	readonly hasRef: (ref: string) => Promise<boolean>
	/** Whether there is a local branch `name`. */
	readonly hasBranch: (name: string) => Promise<boolean>
	/** Whether `remote` (default `origin`) has a branch `name` as far as the repository knows. */
	readonly hasRemoteBranch: (name: string, remote?: string) => Promise<boolean>
	/** The branch the working tree is on, or `HEAD` when it isn't on one. */
	readonly currentBranch: () => Promise<string>
	/** Goes to branch `name`: as it is when it's there, made from `from` otherwise. */
	readonly checkoutOrCreate: (name: string, from: string) => Promise<void>
	/** The paths that make the working tree dirty, tracked changes and untracked files alike. */
	readonly dirtyFiles: () => Promise<readonly string[]>
	/** The paths with unresolved conflicts. */
	readonly conflictedFiles: () => Promise<readonly string[]>
}

/** The git config that applies on every platform, before the caller's. */
const platformConfig: Readonly<Record<string, string>> =
	// Windows stops at 260 characters in a path unless git is told otherwise; a deep tree in a checkout gets there.
	process.platform === 'win32' ? { 'core.longpaths': 'true' } : {}

/** The name of the remote a clone gets. */
const defaultRemote = 'origin'

/** Git's output as its non-empty lines. */
function lines(output: string): string[] {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
}

/**
 * A client for the repository at `options.cwd`. Every command on it is a {@link GitCommand}:
 * awaited it runs and fails on a non-zero exit, `run()` hands the exit back, `attempt()` is best
 * effort, and in a template string it renders as the shell line.
 *
 * ```ts
 * const git = gitClient({ cwd: checkout, abortSignal })
 * await git.fetch('origin', ['main'])
 * if (!(await git.hasBranch('fix/7'))) await git.checkout('fix/7', { create: true, from: 'origin/main' })
 * const { stdout } = await git.revParse('HEAD')
 * ```
 */
export function gitClient(options: GitClientOptions): GitClient {
	const commandOptions: GitCommandOptions = {
		cwd: options.cwd,
		abortSignal: options.abortSignal,
		prefix: Object.entries({ ...platformConfig, ...options.config }).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
		...(options.env === undefined ? {} : { env: options.env }),
	}

	const bound = Object.fromEntries(
		Object.entries(commands).map(([name, build]) => [
			name,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each entry has its own parameters; here the arguments pass as they are
			(...args: unknown[]) => gitCommand((build as (...args: unknown[]) => string[])(...args), commandOptions),
		]),
	)
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from `commands`, whose keys and parameters it mirrors
	const client = bound as ClientCommands

	const hasRef = async (ref: string) => (await client.revParse('--verify', '--quiet', ref).run()).ok
	const hasBranch = (name: string) => hasRef(`refs/heads/${name}`)

	return Object.freeze<GitClient>({
		...client,
		cwd: options.cwd,
		hasRef,
		hasBranch,
		hasRemoteBranch: (name, remote = defaultRemote) => hasRef(`refs/remotes/${remote}/${name}`),
		currentBranch: async () => (await client.revParse('--abbrev-ref', 'HEAD')).stdout.trim(),
		checkoutOrCreate: async (name, from) => {
			if (await hasBranch(name)) await client.checkout(name, { quiet: true })
			else await client.checkout(name, { create: true, from, quiet: true })
		},
		dirtyFiles: async () => lines((await client.status()).stdout),
		conflictedFiles: async () => lines((await client.diff('--name-only', '--diff-filter=U')).stdout),
	})
}
