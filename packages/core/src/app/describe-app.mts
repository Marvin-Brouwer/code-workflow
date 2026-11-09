import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { definedHostTools } from '../gateway/host-tool-stub.mts'
import { jsonSchemaOf } from '../tool/json-schema.mts'
import type { Trigger } from '../triggers/trigger.mts'
import type { AnyWorkflow } from '../workflow/workflow.mts'
import { definedWorkflows } from '../workflow/workflow-registry.mts'
import type { MeshFlowApp } from './define-mesh-flow.mts'

/**
 * What an app declares, as the engine reads it: its sandbox, the workflows, with their parameters
 * as JSON Schema, the app's triggers, and the host tools its modules have stubs of, which are all a
 * run's gateway will take. Schemas are their input side: what a form, a payload or
 * the CLI has to give.
 *
 * The workflows are every workflow defined in this process unless you pass them, because the app's
 * modules define them when its entry file imports them. In a test, pass the ones you expect.
 */
export function describeApp(app: MeshFlowApp, workflows: readonly AnyWorkflow[] = definedWorkflows()): WorkflowsDescription {
	return {
		sandbox: app.sandbox,
		workflows: workflows.map((definition) => ({ name: definition.name, parameters: jsonSchemaOf(definition.parameters) })),
		triggers: app.triggers.map(describeTrigger),
		tools: definedHostTools(),
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
