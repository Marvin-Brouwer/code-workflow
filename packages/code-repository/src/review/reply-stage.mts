import { z } from 'zod'

/**
 * What a reply to a review item is. `plan`: what will be done about it, before it's done. `answer`
 * (the default): the answer to a question, or what was done.
 */
export const ReplyStage = z.enum(['plan', 'answer'])
export type ReplyStage = z.infer<typeof ReplyStage>

/** The stage of a reply that names none. */
export const defaultReplyStage: ReplyStage = 'answer'

/** A reply that found its item gone: deleted since it was read. */
export const GoneReply = z.object({ gone: z.literal(true) })
export type GoneReply = z.infer<typeof GoneReply>

/** Whether a reply found its item gone, rather than posting or editing a comment. */
export function isGoneReply(outcome: object): outcome is GoneReply {
	return 'gone' in outcome
}
