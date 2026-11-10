/**
 * The arguments of every git command the client knows, without the leading `git`: one place says
 * what each command runs, and the client derives both the running and the rendering half from it.
 */
export const commands = {
	init(options: { readonly bare?: boolean; readonly branch?: string; readonly quiet?: boolean } = {}): string[] {
		const args = ['init']
		if (options.quiet === true) args.push('--quiet')
		if (options.bare === true) args.push('--bare')
		if (options.branch !== undefined) args.push('--initial-branch', options.branch)
		return args
	},
	clone(from: string, into: string, options: { readonly branch?: string; readonly quiet?: boolean } = {}): string[] {
		const args = ['clone']
		if (options.quiet === true) args.push('--quiet')
		if (options.branch !== undefined) args.push('--branch', options.branch)
		args.push(from, into)
		return args
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
		const args = ['commit']
		if (options.quiet === true) args.push('--quiet')
		if (options.allowEmpty === true) args.push('--allow-empty')
		if (options.noEdit === true) args.push('--no-edit')
		if (options.message !== undefined) args.push('--message', options.message)
		return args
	},
	/** `git fetch` from a remote or a URL, with refspecs when given. */
	fetch(from: string, refspecs: readonly string[] = [], options: { readonly prune?: boolean; readonly quiet?: boolean } = {}): string[] {
		const args = ['fetch']
		if (options.quiet === true) args.push('--quiet')
		if (options.prune === true) args.push('--prune')
		args.push(from, ...refspecs)
		return args
	},
	/** `git checkout <branch>`, or `-b <branch> [<from>]` to make it. */
	checkout(branch: string, options: { readonly create?: boolean; readonly from?: string; readonly quiet?: boolean } = {}): string[] {
		const args = ['checkout']
		if (options.quiet === true) args.push('--quiet')
		if (options.create === true) args.push('-b')
		args.push(branch)
		if (options.from !== undefined) args.push(options.from)
		return args
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
		const args = ['push']
		if (options.quiet === true) args.push('--quiet')
		if (options.setUpstream === true) args.push('--set-upstream')
		args.push(remote, ...refspecs)
		return args
	},
	diff(...args: string[]): string[] {
		return ['diff', ...args]
	},
	/** `git status --porcelain=v1`: one line per changed or untracked path, none when the tree is clean. */
	status(): string[] {
		return ['status', '--porcelain=v1']
	},
	log(...args: string[]): string[] {
		return ['log', ...args]
	},
	lsFiles(...args: string[]): string[] {
		return ['ls-files', ...args]
	},
	revParse(...args: string[]): string[] {
		return ['rev-parse', ...args]
	},
	/** `git merge-base`: with `--is-ancestor a b` exit 1 is a legitimate "no", so look at `run()`. */
	mergeBase(...args: string[]): string[] {
		return ['merge-base', ...args]
	},
	rebase(onto: string): string[] {
		return ['rebase', onto]
	},
	rebaseAbort(): string[] {
		return ['rebase', '--abort']
	},
	merge(branch: string, options: { readonly noEdit?: boolean } = {}): string[] {
		const args = ['merge']
		if (options.noEdit === true) args.push('--no-edit')
		args.push(branch)
		return args
	},
	mergeAbort(): string[] {
		return ['merge', '--abort']
	},
	reset(target: string, options: { readonly hard?: boolean; readonly soft?: boolean } = {}): string[] {
		const args = ['reset']
		if (options.hard === true) args.push('--hard')
		if (options.soft === true) args.push('--soft')
		args.push(target)
		return args
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
	showRef(ref: string): string[] {
		return ['show-ref', '--verify', '--quiet', ref]
	},
	updateRef(ref: string, commit: string): string[] {
		return ['update-ref', ref, commit]
	},
	/** `git bundle create <file> <refs>`: the commits of the refs (or ranges) in one file. */
	bundleCreate(file: string, refs: readonly string[], options: { readonly quiet?: boolean } = {}): string[] {
		const args = ['bundle', 'create']
		if (options.quiet === true) args.push('--quiet')
		args.push(file, ...refs)
		return args
	},
	/** `git bundle list-heads <file> [<refs>]`: `<commit> <ref>` per line. */
	bundleListHeads(file: string, ...refs: string[]): string[] {
		return ['bundle', 'list-heads', file, ...refs]
	},
} as const satisfies Record<string, (...args: never[]) => string[]>

export type Commands = typeof commands

/** A command's name, as the client has it. */
export type CommandName = keyof Commands

/**
 * The arguments as one line a person could paste in a shell, quoted the POSIX way. For a prompt,
 * a log line or an error, never for running: the client passes arguments as they are.
 */
export function formatCommand(args: readonly string[]): string {
	return ['git', ...args].map(quote).join(' ')
}

/** The argument in single quotes when the shell would read into it otherwise. */
function quote(arg: string): string {
	return arg.length === 0 || /[\s"'$`\\*?|;<>()&#!]/.test(arg) ? `'${arg.replaceAll("'", String.raw`'\''`)}'` : arg
}
