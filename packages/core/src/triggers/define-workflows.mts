import type { Trigger } from './trigger.mts'

/** Triggers that go together, such as the ones a package ships, for the `workflows` of `defineMeshFlow`. */
export interface WorkflowBundle {
	readonly triggers: readonly Trigger[]
}

/**
 * Groups triggers, so they can be handed around as one and listed in `defineMeshFlow`:
 *
 * ```ts
 * export const issueWorkflows = defineWorkflows(userTrigger(fixIssue), schedule(triage, 'daily'))
 *
 * export default defineMeshFlow({ sandbox: image({ name: 'node:22-slim' }), workflows: [issueWorkflows] })
 * ```
 */
export function defineWorkflows(...triggers: Trigger[]): WorkflowBundle {
	assertUnique(triggers)
	return Object.freeze({ triggers: Object.freeze([...triggers]) })
}

/** Throws when two triggers of the same kind have the same id. */
export function assertUnique(triggers: readonly Trigger[]): void {
	const seen = new Set<string>()
	for (const trigger of triggers) {
		const key = `${trigger.kind} ${trigger.id}`
		if (seen.has(key)) throw new Error(`The ${trigger.kind} trigger ${trigger.id} is listed twice.${hintFor(trigger)}`)
		seen.add(key)
	}
}

function hintFor(trigger: Trigger): string {
	if (trigger.kind === 'webhook') return ' Give the second one a name of its own: webhook(workflow, schema, { name }).'
	if (trigger.kind === 'schedule') return ' A workflow has one schedule per cron expression.'
	return ''
}
