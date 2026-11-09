import type { z } from 'zod'
import type { NoParameters, Workflow } from '../workflow/workflow.mts'
import type { ScheduleTrigger } from './trigger.mts'

/**
 * Shorthands for common schedules, at midnight in the engine's time zone. A week starts on Monday.
 */
export const scheduleShorthands = Object.freeze({
	hourly: '0 * * * *',
	daily: '0 0 * * *',
	weekly: '0 0 * * 1',
	monthly: '0 0 1 * *',
})
export type ScheduleShorthand = keyof typeof scheduleShorthands

/** When a schedule fires: a shorthand, or a cron expression. Any string is taken, so editors still suggest the shorthands. */
export type ScheduleWhen = ScheduleShorthand | (string & NonNullable<unknown>)

/** The parameters argument of `schedule`: optional when the workflow needs none. */
type ScheduleParameters<Input> = NoParameters extends Input ? [parameters?: Input] : [parameters: Input]

/**
 * Starts `workflow` on the engine's wall clock, at every moment `when` names, with fixed
 * parameters:
 *
 * ```ts
 * export const triggers = defineWorkflows(
 * 	schedule(cleanUp, 'daily'),
 * 	schedule(weeklyReport, '0 7 * * 1', { team: 'web' }),
 * )
 * ```
 *
 * `when` is `hourly`, `daily`, `weekly` or `monthly` (see {@link scheduleShorthands}), or a cron
 * expression with five fields (minute, hour, day of month, month, day of week), or six with seconds
 * first, in the engine's time zone. A tick is skipped while the previous run of the same schedule
 * is still going.
 */
export function schedule<Shape extends z.ZodRawShape>(
	workflow: Workflow<Shape>,
	when: ScheduleWhen,
	...[parameters]: ScheduleParameters<z.input<z.ZodObject<Shape>>>
): ScheduleTrigger {
	const written = when.trim()
	if (written.length === 0) throw new Error(`The schedule of ${workflow.name} has no cron expression.`)
	const cron = isShorthand(written) ? scheduleShorthands[written] : written
	return Object.freeze({ kind: 'schedule', id: `${workflow.name} ${written}`, workflow, cron, parameters: parameters ?? {} })
}

/** Whether `when` is one of the {@link scheduleShorthands}. */
function isShorthand(when: string): when is ScheduleShorthand {
	return Object.hasOwn(scheduleShorthands, when)
}
