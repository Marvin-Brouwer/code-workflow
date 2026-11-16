import type { Check } from '../check/check.mts'
import { makeGate, type Gate } from './exit.mts'

/** How many times the checks may reject a hand-in before the loop fails, unless `maxRejections` says otherwise. */
const defaultMaxRejections = 5

export interface VerifyOptions {
	/** How many rejected hand-ins the loop allows before it fails with the last findings. Default: 5. */
	readonly maxRejections: number
}

/**
 * Lets the agent finish only when every check passes. The checks run concurrently when the agent
 * hands in, and their findings go back to the agent to fix. After `maxRejections` rejections the
 * loop fails with a `ChecksFailed` error.
 *
 * Alone, `verify` is how the agent hands in. Next to `succeed` or `propose` it's a gate in front of
 * them: the checks run when the agent calls one of those.
 *
 * ```ts
 * await developer.loop`Implement ${plan.path}, then hand in with ${verify(dotnet.testsPass(repository))}.`
 * ```
 */
export function verify(...checks: readonly Check[]): Gate
export function verify(options: VerifyOptions, ...checks: readonly Check[]): Gate
export function verify(...values: readonly (Check | VerifyOptions)[]): Gate {
	const options = values.find(isOptions)
	const checks = values.filter((value): value is Check => !isOptions(value))
	const maxRejections = options?.maxRejections ?? defaultMaxRejections
	if (!Number.isInteger(maxRejections) || maxRejections < 1)
		throw new RangeError(`maxRejections is ${maxRejections}: use a whole number, 1 or more.`)
	if (checks.length === 0) throw new Error('verify needs at least one check.')
	return makeGate({ kind: 'verify', checks, maxRejections })
}

function isOptions(value: Check | VerifyOptions): value is VerifyOptions {
	return 'maxRejections' in value
}
