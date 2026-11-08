import { makeExit, type Exit } from './exit.mts'

/**
 * Lets the agent give up, with a reason. `loop` then rejects with an `AgentGaveUp` error that holds
 * it.
 *
 * ```ts
 * await planner.loop`... If the story can't be planned with the information available, ${fail}.`
 * ```
 */
export const fail: Exit<never> = makeExit({ kind: 'fail' })
