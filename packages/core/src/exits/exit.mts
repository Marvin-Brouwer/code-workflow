import type { z } from 'zod'
import type { Check } from '../check/check.mts'
import type { WorkspaceFolder } from '../workspace/workspace-folder.mts'

/** What an exit does when the agent calls it. Read by the loop. */
export type ExitSpecification =
	| { readonly kind: 'succeed'; readonly schema?: z.ZodType; readonly folder?: WorkspaceFolder }
	| { readonly kind: 'propose'; readonly schema: z.ZodType }
	| { readonly kind: 'fail' }

/** What a gate checks before the agent may finish. Read by the loop. */
export interface GateSpecification {
	readonly kind: 'verify'
	readonly checks: readonly Check[]
	readonly maxRejections: number
}

export const exitSpecification: unique symbol = Symbol.for('mesh-flow.exit')
/** Only a type: carries an exit's result type, so `loop` can infer it. */
declare const resultType: unique symbol

/**
 * An exit tool that finishes the loop with a result of type `T`: `succeed`, `propose` or `fail`.
 * Interpolate it in a loop's template; it's the only way an agent's result gets back to code.
 */
export interface Exit<Result> {
	readonly [exitSpecification]: ExitSpecification
	readonly [resultType]?: Result
}

/** An exit that only decides whether the agent may finish: `verify`. It adds nothing to the result. */
export interface Gate {
	readonly [exitSpecification]: GateSpecification
}

/** An exit for `specification`. `Result`, the result type, only exists for the compiler. */
export function makeExit<Result>(specification: ExitSpecification): Exit<Result> {
	return Object.freeze({ [exitSpecification]: Object.freeze(specification) })
}

/** A gate for `specification`. */
export function makeGate(specification: GateSpecification): Gate {
	return Object.freeze({ [exitSpecification]: Object.freeze(specification) })
}

/** Whether a value is an exit or a gate. */
export function isExit(value: unknown): value is Exit<unknown> | Gate {
	return typeof value === 'object' && value !== null && exitSpecification in value
}
