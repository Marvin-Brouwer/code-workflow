import type { z } from 'zod'
import { makeExit, type Exit } from './exit.mts'

/**
 * Lets the agent finish only once a human approves its proposal. The run waits for the answer;
 * time spent waiting doesn't count toward the loop's `limit`. A rejection goes back to the agent
 * with the human's feedback, and the agent can propose again.
 *
 * ```ts
 * const plan = await planner.loop`
 * 	Write a plan to plan.md, then propose it with ${propose(Plan)}.
 * 	When the proposal is rejected, revise the plan with the feedback and propose it again.
 * `
 * ```
 */
export function propose<T extends z.ZodType>(schema: T): Exit<z.output<T>> {
	return makeExit({ kind: 'propose', schema })
}
