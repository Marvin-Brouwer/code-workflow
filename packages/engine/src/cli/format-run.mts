import { signInCommandLine, signInPromptLine } from '../engine/sign-in-lines.mts'
import type { SignInState } from '../engine/sign-in-state.mts'
import type { RunRecord } from '../runs/run-record.mts'

/** One line per run, for `list`. */
export function formatRunLine(record: RunRecord): string {
	const inputs = record.pending.filter((request) => request.kind === 'input').map((request) => request.id)
	const logins = [...new Set(record.pending.flatMap((request) => (request.kind === 'login' ? [request.connector] : [])))]
	const needs = [
		...(inputs.length > 0 ? [`needs input: ${inputs.join(', ')}`] : []),
		...(logins.length > 0 ? [`needs login: ${logins.join(', ')}`] : []),
	]
	return [`${record.id}  ${record.workflow}  ${record.status}`, ...needs].join('  ')
}

/** Every label of `show` is padded to this width, and continuation lines are indented by it. */
const labelWidth = 11

/** A label and its value, with the value's further lines lined up under its first. */
function field(label: string, value: string): string {
	return `  ${`${label}:`.padEnd(labelWidth - 2)}${value.replaceAll('\n', `\n${' '.repeat(labelWidth)}`)}`
}

/** Where to sign in to `connector`, as far as the engine's sign-in got. */
function signInLines(connector: string, signIns: readonly SignInState[]): string[] {
	const signIn = signIns.find((candidate) => candidate.connector === connector)
	const lines: string[] = []
	lines.push(`    ${signIn?.prompt ? signInPromptLine(signIn.prompt) : 'waiting for a code from the service'}`)
	if (signIn?.error) lines.push(`    the last try failed: ${signIn.error}`)
	lines.push(`    ${signInCommandLine(connector)}`)
	return lines
}

/** Everything about one run, for `show`, with where to sign in when it waits for a sign-in. */
export function formatRun(record: RunRecord, signIns: readonly SignInState[] = []): string {
	const lines = [
		`${record.id}: ${record.workflow}, ${record.status}`,
		field('app', record.app.version),
		field('trigger', `${record.trigger.kind} ${record.trigger.id}`),
		field('started', record.createdAt),
		field('updated', record.updatedAt),
	]
	if (record.sandbox) lines.push(field('sandbox', `${record.sandbox.id} on ${record.sandbox.backend}`))
	if (record.error) lines.push(field('error', record.error))
	for (const [model, used] of Object.entries(record.usage ?? {})) {
		const tokens = `${String(used.inputTokens)} in, ${String(used.outputTokens)} out, ${String(used.cacheReadTokens)} cached`
		lines.push(field('usage', `${model}: ${String(used.requests)} requests, ${tokens}, ${used.costUsd.toFixed(4)} USD`))
	}
	for (const request of record.pending) {
		if (request.kind === 'input') {
			lines.push(`  input ${request.id}: ${request.question}`, `    fields: ${JSON.stringify(request.fields)}`)
			lines.push(`    answer: mesh-flow answer ${record.id} ${request.id} '<json>'`)
		} else if (request.kind === 'login') {
			lines.push(`  login ${request.id}: sign in to ${request.connector}`, ...signInLines(request.connector, signIns))
		} else {
			lines.push(`  wake ${request.id} at ${request.at}`)
		}
	}
	return lines.join('\n')
}
