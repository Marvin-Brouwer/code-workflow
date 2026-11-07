import type { Command, Sandbox, StartInBackgroundOptions } from './sandbox.mts'

/**
 * `startInBackground` for backends whose `exec` may leave a process behind: it runs in its own
 * session (`setsid -f`), not as a job the backend manages, because microsandbox refuses a full
 * snapshot while it manages a running job. The image needs `setsid` (util-linux).
 */
export async function startInOwnSession(
	sandbox: Pick<Sandbox, 'exec'>,
	command: Command,
	options: StartInBackgroundOptions,
): Promise<void> {
	const { logFile = '/dev/null', ...execOptions } = options
	const script = 'log=$1; shift; exec setsid -f "$@" > "$log" 2>&1 < /dev/null'
	const result = await sandbox.exec(['sh', '-c', script, 'sh', logFile, ...command], execOptions)
	if (result.exitCode !== 0) {
		throw new Error(`Starting ${command[0]} failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`)
	}
}
