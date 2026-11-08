import { z } from 'zod'
import { RequestId } from './request-id.mts'

/**
 * The runtime asks a human for input and waits. `fields` describes what to ask for, as JSON
 * Schema per field; the runtime validates the answer, the engine passes it through.
 */
export const InputRequest = z.object({
	kind: z.literal('input'),
	id: RequestId,
	question: z.string(),
	fields: z.record(z.string(), z.unknown()),
})
export type InputRequest = z.infer<typeof InputRequest>

/**
 * The runtime waits until a moment in time. Timers inside a sandbox don't agree across a pause
 * (E2B stops the guest's clock, gVisor doesn't), so the engine keeps the time and answers it.
 */
export const WakeRequest = z.object({
	kind: z.literal('wake'),
	id: RequestId,
	at: z.iso.datetime({ offset: true }),
})
export type WakeRequest = z.infer<typeof WakeRequest>

/** Something the runtime waits on that only the engine can answer. */
export const RuntimeRequest = z.discriminatedUnion('kind', [InputRequest, WakeRequest])
export type RuntimeRequest = z.infer<typeof RuntimeRequest>
