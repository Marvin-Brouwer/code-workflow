import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { duration } from '@mesh-flow/duration'

/** How to call runsc, and the flags every call shares. */
export interface RunscConfig {
	/** For example `['runsc']`, or `['sudo', 'runsc']` when the engine doesn't run as root. */
	readonly command: readonly string[]
	/** runsc's own state directory (`--root`). */
	readonly root: string
	/** `systrap` (runsc's default) works everywhere; `kvm` is faster where `/dev/kvm` exists. */
	readonly platform?: string
}

export interface RunscCall {
	readonly signal: AbortSignal
	/** Written to stdin. */
	readonly input?: string | Uint8Array
	/**
	 * Sends output to this file instead of returning it. `run --detach` and `restore --detach`
	 * need it: the container keeps the stdio it was started with open. Each call starts the file
	 * afresh, because runsc as root leaves it unwritable for the engine's own user.
	 */
	readonly logFile?: string
}

export interface RunscResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/**
 * How long output may still come in after runsc exits. A command that leaves a background process
 * behind (`sh -c 'server &'`) keeps stdout open, and the call shouldn't wait for that process.
 */
const outputGrace = duration.of('200ms')

/**
 * Runs `runsc <flags> <args>`. Aborting kills it. Without a network (`--network=none`), and the
 * sandbox can't connect to the host's Unix sockets either, so it has no way out.
 */
export function runsc(config: RunscConfig, commandArguments: readonly string[], call: RunscCall): Promise<RunscResult> {
	const [program = 'runsc', ...prefix] = config.command
	const flags = [`--root=${config.root}`, '--network=none']
	if (config.platform !== undefined) flags.push(`--platform=${config.platform}`)

	const log = call.logFile === undefined ? undefined : freshFile(call.logFile)
	const child = spawn(program, [...prefix, ...flags, ...commandArguments], {
		signal: call.signal,
		stdio: [call.input === undefined ? 'ignore' : 'pipe', log ?? 'pipe', log ?? 'pipe'],
	})
	if (log !== undefined) closeSync(log)
	// runsc may exit before it read all of its input (a container that is gone). That is an EPIPE
	// here, and runsc's exit code already says what went wrong.
	child.stdin?.on('error', () => undefined)
	child.stdin?.end(call.input)

	let stdout = ''
	let stderr = ''
	child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
		stdout += chunk
	})
	child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk
	})
	return new Promise((resolve, reject) => {
		let grace: NodeJS.Timeout | undefined
		child.once('error', (error) => {
			clearTimeout(grace)
			reject(error)
		})
		child.once('exit', () => {
			grace = setTimeout(() => {
				child.stdout?.destroy()
				child.stderr?.destroy()
			}, outputGrace.to('ms'))
		})
		child.once('close', (code) => {
			clearTimeout(grace)
			resolve({ exitCode: code ?? 1, stdout, stderr })
		})
	})
}

/** Replaces the file rather than opening it: removing only needs the directory to be writable. */
function freshFile(file: string): number {
	rmSync(file, { force: true })
	return openSync(file, 'w')
}

/** How much of a log file an error carries. */
const logTailLines = 20

/**
 * Like {@link runsc}, but a non-zero exit code is an error that carries runsc's stderr, or the end
 * of the log file when the call wrote its output there.
 */
export async function runscOrThrow(config: RunscConfig, commandArguments: readonly string[], call: RunscCall): Promise<string> {
	const result = await runsc(config, commandArguments, call)
	if (result.exitCode === 0) return result.stdout
	const output = call.logFile === undefined ? result.stderr : tailOf(call.logFile)
	throw new Error(`runsc ${commandArguments[0] ?? ''} exited with ${String(result.exitCode)}: ${output.trim()}`)
}

/** The last {@link logTailLines} lines of a file. */
function tailOf(file: string): string {
	try {
		return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-logTailLines).join('\n')
	} catch {
		return `(could not read ${file})`
	}
}
