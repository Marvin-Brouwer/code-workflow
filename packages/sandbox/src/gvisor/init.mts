import { quote } from 'shell-quote'
import type { Command, StartInBackgroundOptions } from '../sandbox.mts'

/**
 * Where the sandbox's init takes jobs from: a FIFO, and the scripts it names. Not under the egress
 * mount point, which is read-only.
 */
export const jobDirectory = '/run/mesh-flow-jobs'
export const jobFifo = `${jobDirectory}/start`

/**
 * The container's init, a shell that starts each job named on the FIFO as its own child.
 *
 * Processes started with `runsc exec` don't survive a checkpoint, children of init do. So a
 * background process goes through init rather than through exec. A `service`, such as the egress
 * forwarder, is started first. Holding the FIFO open for reading and writing means it never ends.
 */
export function initCommand(service?: readonly string[]): string[] {
	const script = [
		`mkdir -p ${jobDirectory} && rm -f ${jobFifo} && mkfifo ${jobFifo} || exit 1`,
		'[ $# -gt 0 ] && "$@" &',
		`exec 3<> ${jobFifo}`,
		'while :; do',
		'	if read -r job <&3; then sh "$job" & fi',
		'done',
	].join('\n')
	return ['sh', '-c', script, 'sh', ...(service ?? [])]
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The script init runs for a job. It removes itself first, so jobs leave nothing behind. */
export function jobScript(command: Command, options: StartInBackgroundOptions): string {
	const lines = ['rm -f -- "$0"']
	if (options.cwd !== undefined) lines.push(`cd -- ${quote([options.cwd])} || exit 1`)
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (!environmentName.test(name)) throw new Error(`${name} is not a valid environment variable name.`)
		lines.push(`export ${name}=${quote([value])}`)
	}
	lines.push(`exec ${quote(command)} > ${quote([options.logFile ?? '/dev/null'])} 2>&1 < /dev/null`)
	return `${lines.join('\n')}\n`
}
