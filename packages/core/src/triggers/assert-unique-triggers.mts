import type { Trigger } from './trigger.mts'

/** Throws when two triggers of the same kind have the same id. */
export function assertUniqueTriggers(triggers: readonly Trigger[]): void {
	const seen = new Set<string>()
	for (const trigger of triggers) {
		const key = `${trigger.kind} ${trigger.id}`
		if (seen.has(key)) throw new Error(`The ${trigger.kind} trigger ${trigger.id} is listed twice.${hintFor(trigger)}`)
		seen.add(key)
	}
}

function hintFor(trigger: Trigger): string {
	if (trigger.kind === 'webhook') return ' Give the second one a name of its own: webhook(workflow, schema, { name }).'
	if (trigger.kind === 'schedule') return ' A workflow has one schedule per `when`.'
	return ''
}
