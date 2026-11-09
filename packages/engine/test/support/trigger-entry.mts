import { runtimeScript } from './test-app.mts'

/**
 * A stand-in for a built app's entry file, as the engine sees it: it sends an event with what it
 * was started with, skips a webhook delivery whose `label` isn't `ai-fix` (as a `.refine` would),
 * and then runs `body`.
 */
export function triggerEntry(body = `mailbox.send({ type: 'succeeded' })`): string {
	return runtimeScript(`
const start = await mailbox.readStart(signal)
if (start.trigger?.kind === 'webhook' && start.input?.label !== 'ai-fix') {
	mailbox.send({ type: 'skipped', reason: 'The delivery is not for ' + start.workflow + ': only ai-fix.' })
} else {
	event('started', 'started', { workflow: start.workflow, trigger: start.trigger ?? null, input: start.input ?? null })
	${body}
}
`)
}
