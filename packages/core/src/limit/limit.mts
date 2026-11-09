import { counted } from '../render/counted.mts'
import { toPrompt } from '../render/to-prompt.mts'

/** A loop-wide limit. */
export interface LimitSpec {
	/** Model turns: each response of the model counts once. */
	readonly turns?: number
	/** Minutes of the agent's own runtime. Time spent waiting on a human doesn't count. */
	readonly minutes?: number
}

/** Where a limit keeps its spec, for the loop to read. */
export const limitSpec: unique symbol = Symbol.for('mesh-flow.limit')

/** A loop's limit, interpolated in its template. */
export interface Limit {
	readonly [limitSpec]: LimitSpec
	[toPrompt](): string
}

/**
 * Limits a loop as a whole. Interpolate it once, next to the exits; it renders as a line the agent
 * reads, so it can plan for its budget. Going over it rejects the loop with a `LoopLimitExceeded`
 * error.
 *
 * ```ts
 * await planner.loop`
 * 	Write a short merge request description for ${repository}. ${succeed(Description)}
 * 	${limit({ turns: 4, minutes: 20 })}
 * `
 * ```
 */
export function limit(spec: LimitSpec): Limit {
	for (const [name, value] of Object.entries(spec)) {
		if (typeof value !== 'number' || !(value > 0)) throw new RangeError(`limit ${name} is ${String(value)}: use a number above 0.`)
	}
	if (spec.turns !== undefined && !Number.isInteger(spec.turns)) throw new RangeError(`limit turns is ${spec.turns}: use a whole number.`)
	if (spec.turns === undefined && spec.minutes === undefined) throw new Error('limit needs turns, minutes or both.')
	return Object.freeze({ [limitSpec]: spec, [toPrompt]: () => limitLine(spec) })
}

/** Whether a value is a limit. */
export function isLimit(value: unknown): value is Limit {
	return typeof value === 'object' && value !== null && limitSpec in value
}

function limitLine({ turns, minutes }: LimitSpec): string {
	const parts = [
		turns === undefined ? undefined : counted(turns, 'model turn'),
		minutes === undefined ? undefined : `${counted(minutes, 'minute')} of work`,
	]
	return `You have at most ${parts.filter((part) => part !== undefined).join(' and ')} for this task.`
}
