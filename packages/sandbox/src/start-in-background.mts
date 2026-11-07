import type { Command, ExecOptions, Sandbox } from './sandbox.mts'

export interface StartOptions extends ExecOptions {
	/** Where stdout and stderr go, inside the sandbox. Default `/dev/null`. */
	readonly logFile?: string
}

/**
 * Starts a command that keeps running after this call returns, such as the workflow runtime.
 *
 * It runs in its own session (`setsid -f`), not as a job the backend manages: microsandbox
 * refuses a full snapshot while it manages a running job. The image needs `setsid` (util-linux).
 */
export async function startInBackground(sandbox: Sandbox, command: Command, options: StartOptions): Promise<void> {
	const { logFile = '/dev/null', ...execOptions } = options
	const script = 'log=$1; shift; exec setsid -f "$@" > "$log" 2>&1 < /dev/null'
	const result = await sandbox.exec(['sh', '-c', script, 'sh', logFile, ...command], execOptions)
	if (result.exitCode !== 0) {
		throw new Error(`Starting ${command[0]} failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`)
	}
}
