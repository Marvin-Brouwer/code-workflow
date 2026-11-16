import { durationMs, type WaitSpec } from '@mesh-flow/core'

/** How long `review` and `checksPass` wait between looks at the code host when no interval is given. */
export const defaultLookEvery: WaitSpec = { seconds: 10 }

/** How long looks at the code host may keep failing before a watch gives up, when no duration is given. */
export const defaultToleratedOutage: WaitSpec = { minutes: 10 }

/** A zero interval still counts as one look. */
const atLeastOneLookMs = 1

/** How many looks, `every` apart, fit in `duration`, rounded up. */
export function looksWithin(duration: WaitSpec, every: WaitSpec): number {
	return Math.ceil(durationMs(duration) / Math.max(durationMs(every), atLeastOneLookMs))
}

/** How long a watch waits for a pipeline or checks to appear on a fresh commit, when no duration is given. */
export const defaultAppearWithin: WaitSpec = { minutes: 10 }
