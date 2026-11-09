import { z } from 'zod'
import { RuntimeRequest } from './runtime-request.mts'
import { WorkflowsDescription } from './workflows-description.mts'

/**
 * One node of a run's event tree. The engine checks only these fields and keeps the rest as it
 * is: what an event means is up to the runtime and the UI.
 */
export const RuntimeEvent = z.looseObject({
	id: z.string().min(1),
	parentId: z.string().min(1).optional(),
	type: z.string().min(1),
	at: z.iso.datetime({ offset: true }),
})
export type RuntimeEvent = z.infer<typeof RuntimeEvent>

/** What the runtime in the sandbox tells the engine, one per line of its outbox. */
export const RuntimeMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('event'), event: RuntimeEvent }),
	z.object({ type: z.literal('request'), request: RuntimeRequest }),
	z.object({ type: z.literal('succeeded') }),
	z.object({ type: z.literal('failed'), error: z.string() }),
	/** The run is over without doing anything: the delivery that started it isn't for its workflow. */
	z.object({ type: z.literal('skipped'), reason: z.string() }),
	/** The answer to a `describe` start: what the entry file declares. */
	z.object({ type: z.literal('described'), description: WorkflowsDescription }),
])
export type RuntimeMessage = z.infer<typeof RuntimeMessage>

/** What the engine puts in the inbox for a request. A wake gets no value. */
export interface Answer {
	readonly value?: unknown
}
