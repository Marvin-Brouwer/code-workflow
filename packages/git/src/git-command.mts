import { formatCommand } from './commands.mts'
import { runGit, type GitResult, type RunGitOptions } from './run-git.mts'

/**
 * A git command that hasn't run yet. What happens depends on how it's used:
 *
 * - `await command` runs it and throws when git exits non-zero. For the common case, where the
 *   caller can't go on without it.
 * - `await command.run()` runs it and never throws for a non-zero exit: look at `ok`, `exitCode`
 *   and `stderr`. For a question git answers with its exit code, such as `showRef`.
 * - `await command.attempt()` runs it and swallows everything, result and errors. For cleanup in
 *   an error path, such as `rebaseAbort`, where its own failure mustn't hide the first one.
 * - `String(command)` or `${command}` renders it as a shell line, for a prompt or a log. Nothing
 *   runs.
 */
export interface GitCommand extends PromiseLike<GitResult> {
	/** The arguments, without the leading `git`. */
	readonly args: readonly string[]
	readonly run: () => Promise<GitResult>
	readonly attempt: () => Promise<void>
	readonly toString: () => string
}

/** What `gitCommand` takes besides the arguments: how it runs, and what goes before the arguments when it does. */
export interface GitCommandOptions extends RunGitOptions {
	/** Arguments before the command's own on every run, such as `-c key=value`, left out when the command is rendered. */
	readonly prefix?: readonly string[]
}

/** A command over `args` that runs with `options` when used. */
export function gitCommand(args: readonly string[], options: GitCommandOptions): GitCommand {
	const run = () => runGit([...(options.prefix ?? []), ...args], options)
	const succeed = async (): Promise<GitResult> => {
		const result = await run()
		if (!result.ok) {
			const detail = result.stderr.trim() || result.stdout.trim()
			throw new Error(`\`${formatCommand(args)}\` failed (exit ${String(result.exitCode)})${detail === '' ? '' : `: ${detail}`}`)
		}
		return result
	}
	return Object.freeze<GitCommand>({
		args,
		run,
		attempt: async () => {
			try {
				await run()
			} catch {
				// Best effort: a stop or a missing git while cleaning up is not the caller's problem.
			}
		},
		toString: () => formatCommand(args),
		// oxlint-disable-next-line unicorn/no-thenable -- awaiting a command is how it runs; that is the point of it
		then: (onFulfilled, onRejected) => succeed().then(onFulfilled, onRejected),
	})
}
