import { assertUniqueTriggers } from './assert-unique-triggers.mts'
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
	assertUniqueTriggers(triggers)
	return Object.freeze({ triggers: Object.freeze([...triggers]) })
}
