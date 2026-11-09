import type { z } from 'zod'
import type { Workflow } from '../workflow/workflow.mts'
import type { UserTrigger } from './trigger.mts'

/**
 * A button in the UI that starts `workflow`. The workflow's parameters become the button's form,
 * filled in before the run starts; a workflow without parameters gets a plain button.
 *
 * ```ts
 * export const triggers = defineWorkflows(userTrigger(fixIssue))
 * ```
 */
export function userTrigger<Shape extends z.ZodRawShape>(workflow: Workflow<Shape>): UserTrigger {
	return Object.freeze({ kind: 'user', id: workflow.name, workflow })
}
