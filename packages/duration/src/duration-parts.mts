/** The parts of a duration, as {@link duration} takes them. Missing parts are zero; all of them add up. */
export interface DurationParts {
	readonly days?: number
	readonly hours?: number
	readonly minutes?: number
	readonly seconds?: number
	readonly milliseconds?: number
}
