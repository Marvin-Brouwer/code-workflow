import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { webhookPath } from '../triggers/webhook-api.mts'

/** What the app declares, for `triggers`: its sandbox, the workflows with their parameters, then the triggers. */
export function formatDescription(description: WorkflowsDescription): string {
	const { image, cpus, memoryMb, registries } = description.sandbox
	const restores = registries.length === 0 ? 'no registries' : `restores from ${registries.map((registry) => registry.name).join(', ')}`
	const lines = [`sandbox: ${image}, ${String(cpus)} CPUs, ${String(memoryMb)} MB, ${restores}`, 'workflows:']
	for (const { name, parameters } of description.workflows) lines.push(`  ${name}  ${JSON.stringify(parameters)}`)
	lines.push('triggers:')
	if (description.triggers.length === 0) lines.push('  none')
	for (const trigger of description.triggers) lines.push(`  ${formatTrigger(trigger)}`)
	return lines.join('\n')
}

function formatTrigger(trigger: TriggerDescription): string {
	if (trigger.kind === 'user') return `user      ${trigger.id}`
	if (trigger.kind === 'schedule') {
		return `schedule  '${trigger.id}'  ${trigger.cron}  ${JSON.stringify(trigger.parameters ?? {})}`
	}
	const { scheme, header } = trigger.signature
	return `webhook   ${trigger.id}  ${trigger.workflow}  POST ${webhookPath(trigger.id)}  (${scheme} in ${header})`
}
