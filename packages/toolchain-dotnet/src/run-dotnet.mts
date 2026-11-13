import { execa, ExecaError } from 'execa'

/** What a `dotnet` invocation came back with. A non-zero exit is a result, not an error: a failed build is one. */
export interface DotnetResult {
	readonly ok: boolean
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/** What `runDotnet` takes besides the arguments. */
export interface RunDotnetOptions {
	/** The directory `dotnet` runs in. */
	readonly cwd: string
	/** Aborting it kills `dotnet` and the processes it started, and rejects the call with the signal's reason. */
	readonly abortSignal: AbortSignal
}

/** How long `dotnet` gets after a stop before it's killed outright. */
const forceKillAfterMs = 2_000

/** How much of the output is kept: more than this fails the call. */
const maxOutputBytes = 64 * 1024 * 1024

/**
 * No telemetry, no first-run banner, and no build servers or MSBuild nodes that outlive the call:
 * one that does holds the output pipes open, and the call would never settle.
 */
const environment = {
	DOTNET_CLI_TELEMETRY_OPTOUT: '1',
	DOTNET_NOLOGO: '1',
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
	DOTNET_CLI_USE_MSBUILD_SERVER: '0',
	MSBUILDDISABLENODEREUSE: '1',
	UseSharedCompilation: 'false',
}

/**
 * Runs `dotnet <args>`: the one place that spawns it. A non-zero exit comes back as `ok: false`;
 * `dotnet` missing, or a stop, rejects. It runs in a process group of its own, which is what a
 * stop goes to, so the compilers and test hosts it started go too.
 */
export async function runDotnet(args: readonly string[], options: RunDotnetOptions): Promise<DotnetResult> {
	const { abortSignal } = options
	abortSignal.throwIfAborted()
	const subprocess = execa('dotnet', args, {
		cwd: options.cwd,
		env: environment,
		stdin: 'ignore',
		maxBuffer: maxOutputBytes,
		reject: false,
		detached: process.platform !== 'win32',
	})
	let exited = false
	let forceKill: NodeJS.Timeout | undefined
	const noteExit = () => {
		exited = true
		clearTimeout(forceKill)
	}
	subprocess.then(noteExit, noteExit)
	const stop = () => {
		// A pid is reused once its process is gone: never signal one that has exited.
		if (exited) return
		killTree(subprocess.pid)
		forceKill = setTimeout(() => {
			if (!exited) killTree(subprocess.pid, 'SIGKILL')
		}, forceKillAfterMs).unref()
	}
	abortSignal.addEventListener('abort', stop, { once: true })
	try {
		const result = await subprocess
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (result.exitCode === undefined) throw new Error(`dotnet could not run: ${result.message}`, { cause: result })
		return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
	} catch (error) {
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (error instanceof ExecaError) throw new Error(`dotnet could not run: ${error.message}`, { cause: error })
		throw error
	} finally {
		abortSignal.removeEventListener('abort', stop)
	}
}

function stoppedWith(abortSignal: AbortSignal): Error {
	return abortSignal.reason instanceof Error ? abortSignal.reason : new Error('The call was stopped.')
}

/** Stops `dotnet` and what it started. */
function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (pid === undefined) return
	try {
		if (process.platform === 'win32') void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
		else process.kill(-pid, signal)
	} catch {
		// Already gone.
	}
}

/** The last lines of a command's output, for a finding when nothing more specific says what went wrong. */
export function outputTail(result: DotnetResult, lines = 30): string {
	return `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-lines).join('\n')
}
