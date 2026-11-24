/**
 * The arguments of every git command the client knows, without the leading `git`: one place says
 * what each command runs, and the client derives both the running and the rendering half from it.
 */
export const commands = {
	init(options: { readonly bare?: boolean; readonly branch?: string; readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['init']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.bare === true) commandArguments.push('--bare')
		if (options.branch !== undefined) commandArguments.push('--initial-branch', options.branch)
		return commandArguments
	},
	clone(from: string, into: string, options: { readonly branch?: string; readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['clone']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.branch !== undefined) commandArguments.push('--branch', options.branch)
		commandArguments.push(from, into)
		return commandArguments
	},
	/** `git add`: the paths given, or everything. */
	add(...paths: string[]): string[] {
		return ['add', ...(paths.length > 0 ? paths : ['--all'])]
	},
	/** `git commit` with `message`, or without one (`noEdit`) to keep the message a merge or a rebase left. */
	commit(options: {
		readonly message?: string
		readonly allowEmpty?: boolean
		readonly noEdit?: boolean
		readonly quiet?: boolean
	}): string[] {
		const commandArguments = ['commit']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.allowEmpty === true) commandArguments.push('--allow-empty')
		if (options.noEdit === true) commandArguments.push('--no-edit')
		if (options.message !== undefined) commandArguments.push('--message', options.message)
		return commandArguments
	},
	/** `git fetch` from a remote or a URL, with refspecs when given. */
	fetch(from: string, refspecs: readonly string[] = [], options: { readonly prune?: boolean; readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['fetch']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.prune === true) commandArguments.push('--prune')
		commandArguments.push(from, ...refspecs)
		return commandArguments
	},
	/** `git checkout <branch>`, or `-b <branch> [<from>]` to make it. */
	checkout(branch: string, options: { readonly create?: boolean; readonly from?: string; readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['checkout']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.create === true) commandArguments.push('-b')
		commandArguments.push(branch)
		if (options.from !== undefined) commandArguments.push(options.from)
		return commandArguments
	},
	/** `git checkout -- <paths>`: takes the working tree's paths back to the index. All of them when none are given. */
	checkoutPaths(...paths: string[]): string[] {
		return ['checkout', '--', ...(paths.length > 0 ? paths : ['.'])]
	},
	push(
		remote: string,
		refspecs: readonly string[] = [],
		options: { readonly setUpstream?: boolean; readonly quiet?: boolean } = {},
	): string[] {
		const commandArguments = ['push']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.setUpstream === true) commandArguments.push('--set-upstream')
		commandArguments.push(remote, ...refspecs)
		return commandArguments
	},
	diff(...commandArguments: string[]): string[] {
		return ['diff', ...commandArguments]
	},
	/**
	 * `git status --porcelain=v1`: one `XY path` entry per changed or untracked path, none when the
	 * tree is clean. `untracked: false` leaves untracked files out; `nulTerminated` ends each entry
	 * with a NUL instead of a newline and leaves paths unquoted, for code that reads the paths.
	 */
	status(options: { readonly untracked?: boolean; readonly nulTerminated?: boolean; readonly paths?: readonly string[] } = {}): string[] {
		const commandArguments = ['status', '--porcelain=v1']
		if (options.untracked === false) commandArguments.push('--untracked-files=no')
		if (options.nulTerminated === true) commandArguments.push('-z')
		if (options.paths !== undefined && options.paths.length > 0) commandArguments.push('--', ...options.paths)
		return commandArguments
	},
	log(...commandArguments: string[]): string[] {
		return ['log', ...commandArguments]
	},
	lsFiles(...commandArguments: string[]): string[] {
		return ['ls-files', ...commandArguments]
	},
	/** `git ls-tree`: the files of a commit's tree, such as `lsTree('-z', '--name-only', 'origin/main')`. */
	lsTree(...commandArguments: string[]): string[] {
		return ['ls-tree', ...commandArguments]
	},
	/** `git show`: a commit, or a file as a commit has it with `show('origin/main:README.md')`. */
	show(...commandArguments: string[]): string[] {
		return ['show', ...commandArguments]
	},
	revParse(...commandArguments: string[]): string[] {
		return ['rev-parse', ...commandArguments]
	},
	/** `git merge-base`: with `--is-ancestor a b` exit 1 is a legitimate "no", so look at `run()`. */
	mergeBase(...commandArguments: string[]): string[] {
		return ['merge-base', ...commandArguments]
	},
	rebase(onto: string): string[] {
		return ['rebase', onto]
	},
	rebaseAbort(): string[] {
		return ['rebase', '--abort']
	},
	merge(branch: string, options: { readonly noEdit?: boolean } = {}): string[] {
		const commandArguments = ['merge']
		if (options.noEdit === true) commandArguments.push('--no-edit')
		commandArguments.push(branch)
		return commandArguments
	},
	mergeAbort(): string[] {
		return ['merge', '--abort']
	},
	/** `git reset [--<mode>] [<to>]`: moves the branch to `to` (default HEAD), and the index and working tree as `mode` says. */
	reset(options: { readonly to?: string; readonly mode?: 'soft' | 'mixed' | 'hard'; readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['reset']
		if (options.quiet === true) commandArguments.push('--quiet')
		if (options.mode !== undefined) commandArguments.push(`--${options.mode}`)
		if (options.to !== undefined) commandArguments.push(options.to)
		return commandArguments
	},
	/** `git restore`: puts `paths` back as they are in `source` (default the index), in the working tree, the index, or both. */
	restore(
		paths: readonly string[],
		options: { readonly source?: string; readonly staged?: boolean; readonly worktree?: boolean } = {},
	): string[] {
		const commandArguments = ['restore']
		if (options.source !== undefined) commandArguments.push(`--source=${options.source}`)
		if (options.staged === true) commandArguments.push('--staged')
		if (options.worktree === true) commandArguments.push('--worktree')
		commandArguments.push('--', ...paths)
		return commandArguments
	},
	/** `git config <key> <value>`, or `--get <key>` without a value: exit 1 means it isn't set, so look at `run()`. */
	config(key: string, value?: string): string[] {
		return value === undefined ? ['config', '--get', key] : ['config', key, value]
	},
	/** `git remote`: the remotes' names. */
	remotes(): string[] {
		return ['remote']
	},
	remoteAdd(name: string, url: string): string[] {
		return ['remote', 'add', name, url]
	},
	remoteSetUrl(name: string, url: string): string[] {
		return ['remote', 'set-url', name, url]
	},
	remoteGetUrl(name: string): string[] {
		return ['remote', 'get-url', name]
	},
	/** `git remote set-head <remote> --auto`: records the remote's default branch under `refs/remotes/<remote>/HEAD`. */
	remoteSetHead(name: string): string[] {
		return ['remote', 'set-head', name, '--auto']
	},
	symbolicRef(name: string): string[] {
		return ['symbolic-ref', name]
	},
	/** `git show-ref --verify --quiet <ref>`: exit 1 means there is no such ref, so look at `run()`. */
	showRef(reference: string): string[] {
		return ['show-ref', '--verify', '--quiet', reference]
	},
	updateRef(reference: string, commit: string): string[] {
		return ['update-ref', reference, commit]
	},
	/** `git bundle create <file> <refs>`: the commits of the refs (or ranges) in one file. */
	bundleCreate(file: string, references: readonly string[], options: { readonly quiet?: boolean } = {}): string[] {
		const commandArguments = ['bundle', 'create']
		if (options.quiet === true) commandArguments.push('--quiet')
		commandArguments.push(file, ...references)
		return commandArguments
	},
	/** `git bundle list-heads <file> [<refs>]`: `<commit> <ref>` per line. */
	bundleListHeads(file: string, ...references: string[]): string[] {
		return ['bundle', 'list-heads', file, ...references]
	},
} as const satisfies Record<string, (...commandArguments: never[]) => string[]>

/** The type of {@link commands}: each command's name and its parameters. */
export type Commands = typeof commands

/** A command's name, as the client has it. */
export type CommandName = keyof Commands

/**
 * The arguments as one line a person could paste in a shell, quoted the POSIX way. For a prompt,
 * a log line or an error, never for running: the client passes arguments as they are.
 */
export function formatCommand(commandArguments: readonly string[]): string {
	return ['git', ...commandArguments].map(quote).join(' ')
}

/** The argument in single quotes when the shell would read into it otherwise. */
function quote(argument: string): string {
	return argument.length === 0 || /[\s"'$`\\*?|;<>()&#!]/.test(argument) ? `'${argument.replaceAll("'", String.raw`'\''`)}'` : argument
}
