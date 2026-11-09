import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { webhookPath } from '../triggers/webhook-api.mts'

/** What an app declares, for `triggers`: its sandbox, the workflows with their parameters, then the triggers. */
export function formatDescription(description: WorkflowsDescription, app: string): string {
	const { image, cpus, memoryMb, egress } = description.sandbox
	const reaches = egress.allow.length === 0 ? 'no network' : egress.allow.join(', ')
	const lines = [`sandbox: ${image}, ${String(cpus)} CPUs, ${String(memoryMb)} MB, ${reaches}`, 'workflows:']
	for (const { name, parameters } of description.workflows) lines.push(`  ${name}  ${JSON.stringify(parameters)}`)
	lines.push('triggers:')
	if (description.triggers.length === 0) lines.push('  none')
	for (const trigger of description.triggers) lines.push(`  ${formatTrigger(trigger, app)}`)
	return lines.join('\n')
}

function formatTrigger(trigger: TriggerDescription, app: string): string {
	if (trigger.kind === 'user') return `user      ${trigger.id}`
	if (trigger.kind === 'schedule') {
		return `schedule  '${trigger.id}'  ${trigger.cron}  ${JSON.stringify(trigger.parameters ?? {})}`
	}
	const { scheme, header } = trigger.signature
	return `webhook   ${trigger.id}  ${trigger.workflow}  POST ${webhookPath(app, trigger.id)}  (${scheme} in ${header})`
}
