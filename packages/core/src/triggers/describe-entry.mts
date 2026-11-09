import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { jsonSchemaOf } from '../tool/json-schema.mts'
import { definedWorkflows } from '../workflow/workflow-registry.mts'
import type { WorkflowEntry } from './define-workflows.mts'
import type { Trigger } from './trigger.mts'

/**
 * What an entry file declares, as the engine reads it: every workflow its modules define, with
 * their parameters as JSON Schema, and its triggers. Schemas are their input side: what a form,
 * a payload or the CLI has to give.
 */
export function describeEntry(entry: WorkflowEntry): WorkflowsDescription {
	return {
		workflows: definedWorkflows().map((definition) => ({ name: definition.name, parameters: jsonSchemaOf(definition.parameters) })),
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
