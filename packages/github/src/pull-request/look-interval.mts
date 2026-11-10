import type { WaitSpec } from '@mesh-flow/core'

/** How long `review` and `checksPass` wait between looks at GitHub when no interval is given. */
export const defaultLookEvery: WaitSpec = { seconds: 30 }
