import type { WorkflowsDescription } from '@mesh-flow/protocol'
import { runtimeScript } from './workflow-repository.mts'

/**
 * A stand-in for an entry file made with `defineWorkflows`, as the engine sees it: in describe
 * mode it sends `description`; in run mode it sends an event with what it was started with, skips
 * a webhook delivery whose `label` isn't `ai-fix` (as a `.refine` would), and then runs `body`.
 */
export function triggerEntry(description: WorkflowsDescription, body = `mailbox.send({ type: 'succeeded' })`): string {
	return runtimeScript(`
const start = await mailbox.start(signal)
if (start.mode === 'describe') {
	mailbox.send({ type: 'described', description: ${JSON.stringify(description)} })
} else if (start.trigger?.kind === 'webhook' && start.input?.label !== 'ai-fix') {
	mailbox.send({ type: 'skipped', reason: 'The delivery is not for ' + start.workflow + ': only ai-fix.' })
} else {
	event('started', 'started', { workflow: start.workflow, trigger: start.trigger ?? null, input: start.input ?? null })
	${body}
}
`)
}
