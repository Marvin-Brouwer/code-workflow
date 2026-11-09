import { z } from 'zod'
import { TriggerKind } from './workflows-description.mts'

/** Which trigger started a run: its kind and its id in the entry file. */
export const TriggerRef = z.object({ kind: TriggerKind, id: z.string().min(1) })
export type TriggerRef = z.infer<typeof TriggerRef>

/**
 * What the engine asks of the entry file, in the mailbox's `start.json` before the runtime starts:
 *
 * - `describe`: send what the entry file declares, as a `described` message, and exit;
 * - `run`: run one workflow. `input` is the workflow's parameters, or for a webhook trigger the
 *   delivery's payload, which the trigger's schema turns into them. A schedule's parameters are
 *   in the entry file, so a schedule run has no `input`, unless it was fired by hand with
 *   parameters of its own.
 */
export const RunStart = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('describe') }),
	z.object({ mode: z.literal('run'), workflow: z.string().min(1), trigger: TriggerRef.optional(), input: z.unknown().optional() }),
])
export type RunStart = z.infer<typeof RunStart>
