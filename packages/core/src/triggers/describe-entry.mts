import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { jsonSchemaOf } from '../tool/json-schema.mts'
import type { AnyWorkflow } from '../workflow/workflow.mts'
import { definedWorkflows } from '../workflow/workflow-registry.mts'
import type { WorkflowEntry } from './define-workflows.mts'
import type { Trigger } from './trigger.mts'

/**
 * What an entry file declares, as the engine reads it: the workflows, with their parameters as JSON
 * Schema, and the entry file's triggers. Schemas are their input side: what a form, a payload or
 * the CLI has to give.
 *
 * The workflows are every workflow defined in this process unless you pass them, because the entry
 * file's modules define them when it imports them. In a test, pass the ones you expect.
 */
export function describeEntry(entry: WorkflowEntry, workflows: readonly AnyWorkflow[] = definedWorkflows()): WorkflowsDescription {
	return {
		workflows: workflows.map((definition) => ({ name: definition.name, parameters: jsonSchemaOf(definition.parameters) })),
		triggers: entry.triggers.map(describeTrigger),
	}
}

function describeTrigger(trigger: Trigger): TriggerDescription {
	const { kind, id, workflow } = trigger
	if (kind === 'user') return { kind, id, workflow: workflow.name }
	if (kind === 'webhook') {
		return {
			kind,
			id,
			workflow: workflow.name,
			payload: jsonSchemaOf(trigger.schema),
			signature: trigger.signature,
			...(trigger.deliveryHeader === undefined ? {} : { deliveryHeader: trigger.deliveryHeader }),
		}
	}
	return { kind, id, workflow: workflow.name, cron: trigger.cron, parameters: trigger.parameters }
}
