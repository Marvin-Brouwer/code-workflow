import { execa, ExecaError } from 'execa'

/** How long git gets after a stop before it's killed outright. */
const forceKillAfterMs = 2_000

/**
 * Runs git with `env` on top of the process's and returns its output. Aborting the signal stops
 * it, helpers such as `git-remote-https` included: git runs in a process group of its own, which
 * is what the stop goes to, and an error carrying the signal's reason settles the call at once.
 * Credentials go in `env`, never in `args`: a process list shows arguments.
 */
export async function runGit(
	cwd: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	abortSignal: AbortSignal,
): Promise<string> {
	abortSignal.throwIfAborted()
	const subprocess = execa('git', args, {
		cwd,
		env: { GIT_TERMINAL_PROMPT: '0', ...env },
		stdin: 'ignore',
		detached: process.platform !== 'win32',
	})
	const stop = () => {
		killTree(subprocess.pid)
		setTimeout(() => {
			killTree(subprocess.pid, 'SIGKILL')
		}, forceKillAfterMs).unref()
	}
	abortSignal.addEventListener('abort', stop, { once: true })
	try {
		const { stdout } = await subprocess
		return stdout
	} catch (error) {
		if (abortSignal.aborted) throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('The call was stopped.')
		if (error instanceof ExecaError) throw new Error(`git ${args[0] ?? ''} failed: ${error.message}`, { cause: error })
		throw error
	} finally {
		abortSignal.removeEventListener('abort', stop)
	}
}

/** Stops git and the helpers it started. */
function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (pid === undefined) return
	try {
		if (process.platform === 'win32') void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
		else process.kill(-pid, signal)
	} catch {
		// Already gone.
	}
}
