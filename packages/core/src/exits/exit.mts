import type { z } from 'zod'
import type { Check } from '../check/check.mts'
import type { WorkspaceFolder } from '../workspace/workspace-folder.mts'

/** What an exit does when the agent calls it. Read by the loop. */
export type ExitSpec =
	| { readonly kind: 'succeed'; readonly schema?: z.ZodType; readonly folder?: WorkspaceFolder }
	| { readonly kind: 'propose'; readonly schema: z.ZodType }
	| { readonly kind: 'fail' }

/** What a gate checks before the agent may finish. Read by the loop. */
export interface GateSpec {
	readonly kind: 'verify'
	readonly checks: readonly Check[]
	readonly maxRejections: number
}

export const exitSpec: unique symbol = Symbol.for('mesh-flow.exit')
/** Only a type: carries an exit's result type, so `loop` can infer it. */
declare const resultType: unique symbol

/**
 * An exit tool that finishes the loop with a result of type `T`: `succeed`, `propose` or `fail`.
 * Interpolate it in a loop's template; it's the only way an agent's result gets back to code.
 */
export interface Exit<T> {
	readonly [exitSpec]: ExitSpec
	readonly [resultType]?: T
}

/** An exit that only decides whether the agent may finish: `verify`. It adds nothing to the result. */
export interface Gate {
	readonly [exitSpec]: GateSpec
}

/** An exit for `spec`. `T`, the result type, only exists for the compiler. */
export function makeExit<T>(spec: ExitSpec): Exit<T> {
	return Object.freeze({ [exitSpec]: Object.freeze(spec) })
}

/** A gate for `spec`. */
export function makeGate(spec: GateSpec): Gate {
	return Object.freeze({ [exitSpec]: Object.freeze(spec) })
}

/** Whether a value is an exit or a gate. */
export function isExit(value: unknown): value is Exit<unknown> | Gate {
	return typeof value === 'object' && value !== null && exitSpec in value
}
