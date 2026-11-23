import { createStore } from '@rooted/store'
import { z } from 'zod'
import { read, type Answer } from './api.mts'
import { poll } from './poll.mts'

/**
 * Whether the engine answers on its control socket: runs and apps need it, settings don't. Or
 * that this page has no access any more: `mesh-flow ui` was started again, with a new token.
 */
export type EngineStatus = 'unknown' | 'running' | 'stopped' | 'no-access'

/**
 * The engine's status, shown on every page and read by pages that need the engine. It also says
 * when the UI's server stopped letting this page in, since then nothing about the engine is known.
 */
export const engineStatus = createStore<EngineStatus>('unknown')

const Status = z.object({ running: z.boolean() })

/** The status a refused request means: 401 is the UI's server not letting this page in. */
const unauthorized = 401

/** Keeps {@link engineStatus} up to date until `untilAborted` aborts. */
export function watchEngineStatus(untilAborted: AbortSignal): void {
	poll(async (abortSignal) => {
		const answer = await read('/engine/status', Status, abortSignal)
		engineStatus.update(() => statusOf(answer))
	}, untilAborted)
}

/** What the status route's answer says about the engine. */
function statusOf(answer: Answer<z.infer<typeof Status>>): EngineStatus {
	if (answer.ok) return answer.value.running ? 'running' : 'stopped'
	return answer.status === unauthorized ? 'no-access' : 'stopped'
}
