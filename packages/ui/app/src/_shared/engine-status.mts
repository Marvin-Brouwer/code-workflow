import { createStore } from '@rooted/store'
import { z } from 'zod'
import { read } from './api.mts'
import { poll } from './poll.mts'

/** Whether the engine answers on its control socket. Runs and apps need it; settings don't. */
export type EngineStatus = 'unknown' | 'running' | 'stopped'

/** The engine's status, shown on every page and read by pages that need the engine. */
export const engineStatus = createStore<EngineStatus>('unknown')

const Status = z.object({ running: z.boolean() })

/** Keeps {@link engineStatus} up to date until `abortSignal` aborts. */
export function watchEngineStatus(abortSignal: AbortSignal): void {
	poll(async (signal) => {
		const answer = await read('/engine/status', Status, signal)
		engineStatus.update(() => (answer.ok && answer.value.running ? 'running' : 'stopped'))
	}, abortSignal)
}
