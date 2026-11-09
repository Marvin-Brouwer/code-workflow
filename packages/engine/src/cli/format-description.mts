import type { TriggerDescription, WorkflowsDescription } from '@mesh-flow/protocol'
import { webhookPath } from '../triggers/webhook-api.mts'

/** What an entry file declares, for `triggers`: the workflows with their parameters, then the triggers. */
export function formatDescription(description: WorkflowsDescription, repository: string | undefined): string {
	const lines = ['workflows:']
	for (const { name, parameters } of description.workflows) lines.push(`  ${name}  ${JSON.stringify(parameters)}`)
	lines.push('triggers:')
	if (description.triggers.length === 0) lines.push('  none')
	for (const trigger of description.triggers) lines.push(`  ${formatTrigger(trigger, repository)}`)
	return lines.join('\n')
}

function formatTrigger(trigger: TriggerDescription, repository: string | undefined): string {
	if (trigger.kind === 'user') return `user      ${trigger.workflow}`
	if (trigger.kind === 'schedule') {
		return `schedule  ${trigger.workflow}  ${trigger.cron}  ${JSON.stringify(trigger.parameters ?? {})}`
	}
	const where = repository === undefined ? 'register the repository to serve it' : `POST ${webhookPath(repository, trigger.id)}`
	const { scheme, header } = trigger.signature
	return `webhook   ${trigger.workflow}  ${where}  (${scheme} in ${header})`
}
