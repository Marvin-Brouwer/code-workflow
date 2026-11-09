import type { Exit, Gate } from './exit.mts'

type IsAny<T> = 0 extends 1 & T ? true : false

/** The exits among the interpolated values. An `any` value is skipped rather than taken as an exit. */
type ExitsIn<Values extends readonly unknown[]> = {
	[Index in keyof Values]: IsAny<Values[Index]> extends true ? never : Values[Index] extends Exit<unknown> | Gate ? Values[Index] : never
}[number]

/** Distributes over a union of exits, so `Exit<A> | Exit<B>` gives `A | B`. */
type ResultOfExit<E> = E extends Exit<infer T> ? T : never

/** The exits that finish with a result. `fail` (an `Exit<never>`) never does. */
type FinishingIn<Values extends readonly unknown[]> = Exclude<ExitsIn<Values>, Gate | Exit<never>>

/**
 * What `loop` resolves to, from the values interpolated in its template:
 * - no exit that finishes with a result, and no gate: the agent's final text;
 * - only a gate (`verify`): nothing;
 * - otherwise: the union of the results of the exits.
 *
 * `fail` adds nothing: the loop rejects when the agent calls it.
 */
export type ResultOf<Values extends readonly unknown[]> = [FinishingIn<Values>] extends [never]
	? [Extract<ExitsIn<Values>, Gate>] extends [never]
		? string
		: // oxlint-disable-next-line typescript/no-invalid-void-type -- `loop` resolves to nothing, like `succeed()`
			void
	: ResultOfExit<FinishingIn<Values>>
