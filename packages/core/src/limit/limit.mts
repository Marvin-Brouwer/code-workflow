import type { Duration } from '@mesh-flow/duration'
import { counted } from '../render/counted.mts'
import { toPrompt } from '../render/to-prompt.mts'

/** A loop-wide limit. */
export interface LimitSpecification {
	/** Model turns: each response of the model counts once. */
	readonly turns?: number
	/** The agent's own runtime. Time spent waiting on a human doesn't count. */
	readonly time?: Duration
}

/** Where a limit keeps its specification, for the loop to read. */
export const limitSpecification: unique symbol = Symbol.for('mesh-flow.limit')

/** A loop's limit, interpolated in its template. */
export interface Limit {
	readonly [limitSpecification]: LimitSpecification
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
 * 	${limit({ turns: 4, time: duration.of('20m') })}
 * `
 * ```
 */
export function limit(specification: LimitSpecification): Limit {
	if (specification.turns !== undefined && !(Number.isInteger(specification.turns) && specification.turns > 0)) {
		throw new RangeError(`limit turns is ${String(specification.turns)}: use a whole number above 0.`)
	}
	if (specification.time?.to('ms') === 0) throw new RangeError('limit time is 0ms: use a duration above zero.')
	if (specification.turns === undefined && specification.time === undefined) throw new Error('limit needs turns, time or both.')
	return Object.freeze({ [limitSpecification]: specification, [toPrompt]: () => limitLine(specification) })
}

/** Whether a value is a limit. */
export function isLimit(value: unknown): value is Limit {
	return typeof value === 'object' && value !== null && limitSpecification in value
}

function limitLine({ turns, time }: LimitSpecification): string {
	const parts = [
		turns === undefined ? undefined : counted(turns, 'model turn'),
		time === undefined ? undefined : `${time.toString()} of work`,
	]
	return `You have at most ${parts.filter((part) => part !== undefined).join(' and ')} for this task.`
}
