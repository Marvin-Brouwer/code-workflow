import path from 'node:path'
import { execa, ExecaError } from 'execa'
import { oneAtATime } from './one-at-a-time.mts'

/** What a `dotnet` invocation came back with. A failed exit is a result, not an error: a failed build is one. */
export interface DotnetResult {
	readonly ok: boolean
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

/** How long `dotnet` and what it started get after a stop before they're killed outright. */
const forceKillAfterMs = 2_000

/** How much of the output is kept, in MiB: more than this fails the call. */
const maxOutputMiB = 64

/** `maxOutputMiB` in bytes. */
const maxOutputBytes = maxOutputMiB * 1024 * 1024

/**
 * No telemetry, no first-run banner or workload notices, and no build servers or MSBuild nodes
 * that outlive the call: one that does holds the output pipes open, and the call would never settle.
 */
export const dotnetEnvironment = {
	DOTNET_CLI_TELEMETRY_OPTOUT: '1',
	DOTNET_NOLOGO: '1',
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
	// A notice that workload updates are available would land in the middle of JSON output.
	DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1',
	DOTNET_CLI_USE_MSBUILD_SERVER: '0',
	MSBUILDDISABLENODEREUSE: '1',
	// The terminal logger's output, with its escape codes and its own layout, isn't MSBuild's canonical form.
	MSBUILDTERMINALLOGGER: 'off',
	UseSharedCompilation: 'false',
}

/** Whether processes run in groups of their own here, which a signal to the group reaches all of. */
const hasProcessGroups = process.platform !== 'win32'

/** Whether paths here ignore case, so two spellings of a directory share a turn. */
const pathsIgnoreCase = process.platform === 'win32'

/** Runs in the same directory, one at a time. */
const inTurn = oneAtATime()

/**
 * Runs `dotnet <args>`: the one place that spawns it. A failed exit, or `dotnet` killed from
 * outside, comes back as `ok: false`; `dotnet` missing, too much output, or a stop rejects. Runs in
 * the same directory take turns: they share `obj` and `bin`, which two at once would both write,
 * such as `verify` running the tests and the security check side by side.
 */
export function runDotnet(args: readonly string[], options: RunDotnetOptions): Promise<DotnetResult> {
	const resolved = path.resolve(options.cwd)
	const key = pathsIgnoreCase ? resolved.toLowerCase() : resolved
	return inTurn(key, options.abortSignal, () => spawnDotnet(args, options))
}

/**
 * Runs `dotnet` once. It runs in a process group of its own, which is what a stop goes to, so the
 * compilers and test hosts it started go too.
 */
async function spawnDotnet(args: readonly string[], options: RunDotnetOptions): Promise<DotnetResult> {
	const { abortSignal } = options
	abortSignal.throwIfAborted()
	const subprocess = execa('dotnet', args, {
		cwd: options.cwd,
		env: dotnetEnvironment,
		stdin: 'ignore',
		maxBuffer: maxOutputBytes,
		reject: false,
		detached: hasProcessGroups,
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
			// The group goes even when `dotnet` itself is gone, since a test host that ignores the stop
			// would live on. Its id can't be another's group while the group has members; on Windows
			// the tree was killed outright already, and only `dotnet` itself is checked again.
			if (hasProcessGroups || !exited) killTree(subprocess.pid, 'SIGKILL')
		}, forceKillAfterMs).unref()
	}
	abortSignal.addEventListener('abort', stop, { once: true })
	try {
		const result = await subprocess
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (result.isMaxBuffer) {
			// execa stops `dotnet` itself only: what it started goes too, while the group still has members.
			if (hasProcessGroups) killTree(subprocess.pid, 'SIGKILL')
			throw new Error(`dotnet wrote more than ${String(maxOutputMiB)} MiB of output: dotnet ${args.join(' ')}`)
		}
		// Killed from outside, such as by the system running out of memory: it failed, as a failed exit does.
		if (result.exitCode === undefined && result.signal !== undefined)
			return { ok: false, stdout: result.stdout, stderr: `${result.stderr}\ndotnet was killed with ${result.signal}.` }
		if (result.exitCode === undefined) throw new Error(`dotnet could not run: ${result.message}`, { cause: result })
		return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr }
	} catch (error) {
		if (abortSignal.aborted) throw stoppedWith(abortSignal)
		if (error instanceof ExecaError) throw new Error(`dotnet could not run: ${error.message}`, { cause: error })
		throw error
	} finally {
		abortSignal.removeEventListener('abort', stop)
	}
}

/** The reason the call was stopped, as an error to throw. */
function stoppedWith(abortSignal: AbortSignal): Error {
	return abortSignal.reason instanceof Error ? abortSignal.reason : new Error('The call was stopped.')
}

/** Stops `dotnet` and what it started. */
function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (pid === undefined) return
	try {
		if (hasProcessGroups) process.kill(-pid, signal)
		else void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
	} catch {
		// Already gone.
	}
}

/** No logo, and no build servers: a server that outlives the call holds its output open. */
export const quietArguments = ['-nologo', '--disable-build-servers']

/** The arguments that keep MSBuild's output to what matters, for a build or a test run: no summary, which repeats every error. */
export const quietBuildArguments = [...quietArguments, '-clp:NoSummary']

/** Enough of the end of the output to show what went wrong, without the whole log. */
const tailLineCount = 30

/** The last lines of a command's output, for a finding when nothing more specific says what went wrong. */
export function outputTail(result: DotnetResult, lineCount = tailLineCount): string {
	return `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-lineCount).join('\n')
}
