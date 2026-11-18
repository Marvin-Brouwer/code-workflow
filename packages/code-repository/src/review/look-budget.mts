import { duration, type Duration } from '@mesh-flow/duration'

/** A zero interval still moves a {@link lookBudget} on. */
const atLeastOneLook = duration.of('1ms')

/** Takes one look from a {@link lookBudget}: whether it still fit in the budget. */
export type LookBudget = () => boolean

/**
 * Patience of `within`, counted in looks `every` apart rather than on the clock: a run can be
 * paused between two looks, for hours, and that pause mustn't use the patience up. Each call takes
 * a look, and says whether it fit: once looks `every` apart have covered `within`, none does.
 */
export function lookBudget(within: Duration, every: Duration): LookBudget {
	const step = every.to('ms') > 0 ? every : atLeastOneLook
	// A clock of its own, that only looks move on.
	const start = new Date(0)
	const end = within.after(start)
	let looked = start
	return () => {
		if (looked >= end) return false
		looked = step.after(looked)
		return true
	}
}
