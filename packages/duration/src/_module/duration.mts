/**
 * Durations, written as text such as `'1h15m'` and checked at compile time. Time in mesh-flow is
 * always a `Duration`, never a number with a unit in its name.
 *
 * @module
 */
export { duration, type Duration, type DurationUnit } from '../duration.mts'
export type { CheckedDurationText, DurationParts, DurationText } from '../duration-text.mts'
export { sleep } from '../sleep.mts'
