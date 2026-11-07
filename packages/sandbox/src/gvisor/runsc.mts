import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

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
	readonly input?: string
	/**
	 * Sends output to this file instead of returning it. `run --detach` and `restore --detach`
	 * need it: the container keeps the stdio it was started with open.
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
const outputGraceMs = 200

/**
 * Runs `runsc <flags> <args>`. Aborting kills it. Without a network (`--network=none`): the only
 * way out of a sandbox is the egress socket, which `--host-uds=open` allows it to connect to.
 */
export function runsc(config: RunscConfig, args: readonly string[], call: RunscCall): Promise<RunscResult> {
	const [program = 'runsc', ...prefix] = config.command
	const flags = [`--root=${config.root}`, '--network=none', '--host-uds=open']
	if (config.platform !== undefined) flags.push(`--platform=${config.platform}`)

	const log = call.logFile === undefined ? undefined : openSync(call.logFile, 'a')
	const child = spawn(program, [...prefix, ...flags, ...args], {
		signal: call.signal,
		stdio: [call.input === undefined ? 'ignore' : 'pipe', log ?? 'pipe', log ?? 'pipe'],
	})
	if (log !== undefined) closeSync(log)
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
			}, outputGraceMs)
		})
		child.once('close', (code) => {
			clearTimeout(grace)
			resolve({ exitCode: code ?? 1, stdout, stderr })
		})
	})
}

/** Like {@link runsc}, but a non-zero exit code is an error that carries runsc's stderr. */
export async function runscOrThrow(config: RunscConfig, args: readonly string[], call: RunscCall): Promise<string> {
	const result = await runsc(config, args, call)
	if (result.exitCode !== 0) throw new Error(`runsc ${args[0] ?? ''} exited with ${String(result.exitCode)}: ${result.stderr.trim()}`)
	return result.stdout
}
