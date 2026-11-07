import type { RunRecord } from '../runs/run-record.mts'

/** One line per run, for `list`. */
export function formatRunLine(record: RunRecord): string {
	const inputs = record.pending.filter((request) => request.kind === 'input').map((request) => request.id)
	const needs = inputs.length > 0 ? `  needs input: ${inputs.join(', ')}` : ''
	return `${record.id}  ${record.workflow}  ${record.status}${needs}`
}

/** Everything about one run, for `show`. */
export function formatRun(record: RunRecord): string {
	const lines = [
		`${record.id}: ${record.workflow}, ${record.status}`,
		`  source:  ${record.source.directory} at ${record.source.commit.slice(0, 12)}${record.source.dirty ? ' with uncommitted changes' : ''}`,
		`  started: ${record.createdAt}`,
		`  updated: ${record.updatedAt}`,
	]
	if (record.sandbox) lines.push(`  sandbox: ${record.sandbox.id} on ${record.sandbox.backend}`)
	if (record.error) lines.push(`  error:   ${record.error.replaceAll('\n', '\n           ')}`)
	for (const request of record.pending) {
		if (request.kind === 'input') {
			lines.push(`  input ${request.id}: ${request.question}`, `    fields: ${JSON.stringify(request.fields)}`)
			lines.push(`    answer: mesh-flow answer ${record.id} ${request.id} '<json>'`)
		} else {
			lines.push(`  wake ${request.id} at ${request.at}`)
		}
	}
	return lines.join('\n')
}
