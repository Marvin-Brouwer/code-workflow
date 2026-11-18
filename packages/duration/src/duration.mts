import type { DurationParts } from './duration-parts.mts'
import { isDurationText, partsOf, type CheckedDurationText, type DurationText } from './duration-text.mts'
import { timeoutSignal } from './timeout-signal.mts'

/** The units a duration is written and read in. */
export type DurationUnit = 'd' | 'h' | 'm' | 's' | 'ms'

const millisecondsPer = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
	ms: 1,
} as const satisfies Record<DurationUnit, number>

/** The longest duration, in milliseconds: as far as a `Date` reaches from the epoch. */
const longestMilliseconds = 100_000_000 * millisecondsPer.d

/** The key `@mesh-flow/core` renders a value in a prompt by, so a duration reads as `1h15m` there. */
const toPrompt = Symbol.for('mesh-flow.to-prompt')

/**
 * A length of time. Its parts are spread out from the largest down, so `duration({ minutes: 90 })`
 * has 1 hour and 30 minutes, and it is itself the parts {@link duration} takes.
 */
export interface Duration extends Required<DurationParts> {
	/** The moment this long after `date`. */
	readonly after: (date: Date) => Date
	/** The moment this long before `date`. */
	readonly before: (date: Date) => Date
	/** A signal that aborts with a `TimeoutError` once this long has passed, also when that is longer than `setTimeout` keeps. */
	readonly toAbortSignal: () => AbortSignal
	/**
	 * As a number of `unit`, for an API that takes one, such as `setTimeout` (`'ms'`) or a service
	 * that counts in seconds (`'s'`). A unit smaller than milliseconds doesn't exist, so `'ms'` is
	 * always whole; larger units can be fractions.
	 */
	readonly to: (unit: DurationUnit) => number
	/** As text, such as `'1h15m'`; `'0ms'` when it's zero. */
	readonly toString: () => DurationText
	/** As text, the same as `toString`, so a duration in JSON reads as one. */
	readonly toJSON: () => DurationText
}

/**
 * A duration from its parts. Missing parts are zero, so `duration({})` is no time at all, and a
 * duration itself can be passed as parts. Throws a `RangeError` for a part that isn't a finite
 * number of zero or more, or a total longer than a date can be moved from the epoch, 100 million days.
 *
 * ```ts
 * const reviewWindow = duration({
 * 	hours: 1,
 * 	minutes: 15,
 * })
 * ```
 */
export function duration(parts: DurationParts): Duration {
	const total = Math.round(
		partOf(parts, 'days') * millisecondsPer.d +
			partOf(parts, 'hours') * millisecondsPer.h +
			partOf(parts, 'minutes') * millisecondsPer.m +
			partOf(parts, 'seconds') * millisecondsPer.s +
			partOf(parts, 'milliseconds'),
	)
	return fromMilliseconds(total)
}

/**
 * A duration from text: one or more of `d`, `h`, `m`, `s` and `ms`, largest first. Only literal
 * text compiles, and a typo fails at compile time.
 *
 * ```ts
 * const reviewWindow = duration.of('1h15m')
 * ```
 */
function of<const Text extends DurationText>(text: CheckedDurationText<Text>): Duration {
	return duration(partsOf(text))
}

/** The time from `start` to `end`. Throws a `RangeError` when `end` is before `start`, or either is an invalid date. */
function between(start: Date, end: Date): Duration {
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
		throw new RangeError('There is no time between an invalid date and another.')
	const milliseconds = end.getTime() - start.getTime()
	if (milliseconds < 0) throw new RangeError(`${end.toISOString()} is before ${start.toISOString()}.`)
	return fromMilliseconds(milliseconds)
}

duration.of = of
duration.between = between

/** One part of `parts`, zero when it's missing. Throws a `RangeError` when it isn't a finite number of zero or more. */
function partOf(parts: DurationParts, name: keyof DurationParts): number {
	const value = parts[name] ?? 0
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`A duration's ${name} is ${String(value)}: use a number of zero or more.`)
	}
	return value
}

function fromMilliseconds(total: number): Duration {
	if (total > longestMilliseconds) {
		throw new RangeError('A duration can be at most 100 million days, as far as a date can be moved from the epoch.')
	}
	const days = Math.floor(total / millisecondsPer.d)
	const hours = Math.floor((total % millisecondsPer.d) / millisecondsPer.h)
	const minutes = Math.floor((total % millisecondsPer.h) / millisecondsPer.m)
	const seconds = Math.floor((total % millisecondsPer.m) / millisecondsPer.s)
	const milliseconds = total % millisecondsPer.s
	const text = textOf({ days, hours, minutes, seconds, milliseconds })
	const time: Duration = {
		days,
		hours,
		minutes,
		seconds,
		milliseconds,
		after: (date) => new Date(date.getTime() + total),
		before: (date) => new Date(date.getTime() - total),
		toAbortSignal: () => timeoutSignal(time),
		to: (unit) => total / millisecondsPer[unit],
		toString: () => text,
		toJSON: () => text,
	}
	// Not enumerable, so it stays out of spreads, comparisons and JSON.
	Object.defineProperty(time, toPrompt, { value: () => text })
	return Object.freeze(time)
}

function textOf(parts: Required<DurationParts>): DurationText {
	const units = [
		[parts.days, 'd'],
		[parts.hours, 'h'],
		[parts.minutes, 'm'],
		[parts.seconds, 's'],
		[parts.milliseconds, 'ms'],
	] as const
	const text = units
		.filter(([value]) => value > 0)
		.map(([value, unit]) => `${String(value)}${unit}`)
		.join('')
	if (text === '') return '0ms'
	if (!isDurationText(text)) throw new Error(`Durations are written largest unit first, so this can't happen: ${text}`)
	return text
}
