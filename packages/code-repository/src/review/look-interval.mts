import { duration } from '@mesh-flow/duration'

/** How long `review` and `checksPass` wait between looks at the code host when no interval is given. */
export const defaultLookEvery = duration.of('10s')

/** How long looks at the code host may keep failing before a watch gives up, when no duration is given. */
export const defaultToleratedOutage = duration.of('10m')

/** How long a watch waits for a pipeline or checks to appear on a fresh commit, when no duration is given. */
export const defaultAppearWithin = duration.of('10m')
