import { z } from 'zod'
import { ConnectorName } from './connector-name.mts'
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

/**
 * The runtime waits until the user signed in to a connector's service again, because a host tool
 * answered that it needs a session. The engine runs the connector's sign-in, shows where to sign
 * in, and answers once the user approved; the runtime then calls the tool again.
 */
export const LoginRequest = z.object({
	kind: z.literal('login'),
	id: RequestId,
	connector: ConnectorName,
})
export type LoginRequest = z.infer<typeof LoginRequest>

/**
 * The engine's answer to a `LoginRequest`, as the answer's value. `resumed` says it answered because
 * the run was resumed, not because the user signed in: the runtime calls the tool again, and that
 * doesn't count as one of the call's sign-ins.
 */
export const LoginAnswer = z.object({ resumed: z.boolean().optional() })
export type LoginAnswer = z.infer<typeof LoginAnswer>

/** Something the runtime waits on that only the engine can answer. */
export const RuntimeRequest = z.discriminatedUnion('kind', [InputRequest, WakeRequest, LoginRequest])
export type RuntimeRequest = z.infer<typeof RuntimeRequest>
