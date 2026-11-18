import type { DurationParts } from './duration-parts.mts'

type Part<Unit extends string> = '' | `${number}${Unit}`

/**
 * A duration written as text: one or more of `d`, `h`, `m`, `s` and `ms`, largest first, such as
 * `'1h15m'`, `'30s'` or `'1d12h'`. Only a literal fits, so a typo fails at compile time.
 */
export type DurationText = Exclude<`${Part<'d'>}${Part<'h'>}${Part<'m'>}${Part<'s'>}${Part<'ms'>}`, ''>

/**
 * Characters `${number}` allows that a duration doesn't: a sign, an exponent, a hexadecimal, octal
 * or binary prefix, a space, or `Infinity`.
 */
type NotInDuration = '-' | '+' | 'e' | 'E' | 'x' | 'X' | 'o' | 'O' | 'b' | 'B' | 'I' | ' '

/** A unit's first letter. */
type UnitLetter = 'd' | 'h' | 'm' | 's'

/** Decimals `${number}` allows that a duration doesn't: `.5h`, `1.h`, or a point right after a unit. */
type LooseDecimal = `.${string}` | `${string}.${UnitLetter}${string}` | `${string}${UnitLetter}.${string}`

/** `Text` when it is a duration that can be parsed, `never` otherwise. */
export type CheckedDurationText<Text extends DurationText> = Text extends `${string}${NotInDuration}${string}` | LooseDecimal ? never : Text

const amount = String.raw`(\d+(?:\.\d+)?)`
const durationPattern = new RegExp(String.raw`^(?:${amount}d)?(?:${amount}h)?(?:${amount}m(?!s))?(?:${amount}s)?(?:${amount}ms)?$`)

/** The parts of `text`. Throws a `RangeError` for text that isn't a duration. */
export function partsOf(text: string): DurationParts {
	const match = text === '' ? null : durationPattern.exec(text)
	if (match === null) {
		throw new RangeError(`'${text}' isn't a duration: use d, h, m, s and ms, largest first, such as '1h15m'.`)
	}
	const [, days, hours, minutes, seconds, milliseconds] = Array.from(match, (part: string | undefined) =>
		part === undefined ? undefined : Number(part),
	)
	return {
		...(days === undefined ? {} : { days }),
		...(hours === undefined ? {} : { hours }),
		...(minutes === undefined ? {} : { minutes }),
		...(seconds === undefined ? {} : { seconds }),
		...(milliseconds === undefined ? {} : { milliseconds }),
	}
}

/** Whether `text` is a duration as {@link partsOf} reads it. */
export function isDurationText(text: string): text is DurationText {
	return text !== '' && durationPattern.test(text)
}
