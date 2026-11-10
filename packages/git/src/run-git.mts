import { execa, ExecaError } from 'execa'

/** What a git invocation came back with. A non-zero exit is a result, not an error. */
export interface GitResult {
	/** Whether git exited with 0. */
	readonly ok: boolean
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	/** What ran, starting with `git`, for a log line or an error. */
	readonly command: readonly string[]
}

/** What `runGit` takes besides the arguments. */
export interface RunGitOptions {
	/** The directory git runs in. */
	readonly cwd: string
	/** On top of the process's environment. Credentials go here, never in the arguments: a process list shows arguments. */
	readonly env?: Readonly<Record<string, string>>
	/** Aborting it kills git and the helpers it started, and rejects the call with the signal's reason. */
	readonly abortSignal: AbortSignal
}

/** How long git gets after a stop before it's killed outright. */
const forceKillAfterMs = 2_000

/** How much of git's output is kept: more than this fails the call. */
const maxOutputBytes = 16 * 1024 * 1024

/**
 * Runs `git <args>`: the one place that spawns git. A non-zero exit comes back as `ok: false`,
 * so callers branch on it; everything else (git missing, a stop) rejects. Git runs in a process
 * group of its own, which is what a stop goes to: killing git alone leaves `git-remote-https`
 * holding the pipes, and the call would never settle.
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
	const { abortSignal } = options
	abortSignal.throwIfAborted()
	const subprocess = execa('git', args, {
		cwd: options.cwd,
		env: { GIT_TERMINAL_PROMPT: '0', ...options.env },
		stdin: 'ignore',
		maxBuffer: maxOutputBytes,
		reject: false,
		detached: process.platform !== 'win32',
	})
	let exited = false
	const noteExit = () => {
		exited = true
	}
	subprocess.then(noteExit, noteExit)
	const stop = () => {
		// A pid is reused once its process is gone: never signal one that has exited.
		if (exited) return
		killTree(subprocess.pid)
		setTimeout(() => {
			killTree(subprocess.pid, 'SIGKILL')
		}, forceKillAfterMs).unref()
	}
	abortSignal.addEventListener('abort', stop, { once: true })
	try {
		const result = await subprocess
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (result.failed && result.exitCode === undefined) throw new Error(`git could not run: ${result.message}`, { cause: result })
		return {
			ok: result.exitCode === 0,
			exitCode: result.exitCode ?? 1,
			stdout: result.stdout,
			stderr: result.stderr,
			command: ['git', ...args],
		}
	} catch (error) {
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (error instanceof ExecaError) throw new Error(`git could not run: ${error.message}`, { cause: error })
		throw error
	} finally {
		abortSignal.removeEventListener('abort', stop)
	}
}

function stoppedWith(abortSignal: AbortSignal): Error {
	return abortSignal.reason instanceof Error ? abortSignal.reason : new Error('The call was stopped.')
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
