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
 * forwarder, is started first. Init holds the FIFO open for reading and writing, so `read` never
 * sees end of file and the loop never ends. Jobs don't get that descriptor. Each time a job
 * arrives, `jobs` lets the shell reap the ones that ended since.
 */
export function initCommand(service: readonly string[] = []): string[] {
	const script = [
		`mkdir -p ${jobDirectory} && rm -f ${jobFifo} && mkfifo ${jobFifo} || exit 1`,
		'[ $# -gt 0 ] && "$@" &',
		`exec 3<> ${jobFifo}`,
		'while :; do',
		'	if read -r job <&3; then sh "$job" 3<&- & fi',
		'	jobs > /dev/null',
		'done',
	].join('\n')
	return ['sh', '-c', script, 'sh', ...service]
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The script init runs for a job. It removes itself first, so jobs leave nothing behind. */
export function jobScript(command: Command, options: Omit<StartInBackgroundOptions, 'signal'>): string {
	const lines = ['rm -f -- "$0"']
	if (options.cwd !== undefined) lines.push(`cd -- ${quote([options.cwd])} || exit 1`)
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (!environmentName.test(name)) throw new Error(`${name} is not a valid environment variable name.`)
		lines.push(`export ${name}=${quote([value])}`)
	}
	lines.push(`exec ${quote(command)} > ${quote([options.logFile ?? '/dev/null'])} 2>&1 < /dev/null`)
	return `${lines.join('\n')}\n`
}

/**
 * Hands a job to init. It checks first what the job needs, so a bad directory or log file fails
 * this call, as it does on the other backends, instead of only showing in init's own log. A job
 * that isn't handed over is removed.
 */
export function submitJobCommand(job: string, options: Omit<StartInBackgroundOptions, 'signal'>): Command {
	const script = [
		'job=$1 fifo=$2 log=$3 cwd=$4',
		`[ -p "$fifo" ] || { echo "The sandbox's init isn't taking jobs." >&2; rm -f -- "$job"; exit 1; }`,
		'{ [ -z "$cwd" ] || cd -- "$cwd"; } && : >> "$log" || { rm -f -- "$job"; exit 1; }',
		`printf '%s\\n' "$job" > "$fifo"`,
	].join('\n')
	return ['sh', '-c', script, 'sh', job, jobFifo, options.logFile ?? '/dev/null', options.cwd ?? '']
}
