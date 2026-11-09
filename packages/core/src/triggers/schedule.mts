import type { z } from 'zod'
import type { NoParameters, Workflow } from '../workflow/workflow.mts'
import type { ScheduleTrigger } from './trigger.mts'

/** The parameters argument of `schedule`: optional when the workflow needs none. */
type ScheduleParameters<Input> = NoParameters extends Input ? [parameters?: Input] : [parameters: Input]

/**
 * Starts `workflow` on the engine's wall clock, at every moment `cron` names, with fixed
 * parameters:
 *
 * ```ts
 * export default defineWorkflows(schedule(weeklyReport, '0 7 * * 1', { team: 'web' }))
 * ```
 *
 * `cron` has five fields (minute, hour, day of month, month, day of week), or six with seconds
 * first, in the engine's time zone. A tick is skipped while the previous run of the same schedule
 * is still going.
 */
export function schedule<Shape extends z.ZodRawShape>(
	workflow: Workflow<Shape>,
	cron: string,
	...[parameters]: ScheduleParameters<z.input<z.ZodObject<Shape>>>
): ScheduleTrigger {
	const expression = cron.trim()
	if (expression.length === 0) throw new Error(`The schedule of ${workflow.name} has no cron expression.`)
	return Object.freeze({ kind: 'schedule', id: `${workflow.name} ${expression}`, workflow, cron: expression, parameters: parameters ?? {} })
}
