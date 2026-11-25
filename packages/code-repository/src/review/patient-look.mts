import { GatewayCallError, wait } from '@mesh-flow/core'
import type { Duration } from '@mesh-flow/duration'
import { lookBudget } from './look-budget.mts'

/** What `patientLook` takes. */
export interface PatientLookOptions {
	/** How long to wait before looking again. */
	readonly every: Duration
	/** How long looks may keep failing before the last failure is thrown, counted in looks `every` apart. */
	readonly toleratedOutage: Duration
}

/**
 * Makes a look at a code host that a watch can survive failing: when the host can't do a call, because
 * the network or the code host is down for longer than the host's own retries cover, the look is tried
 * again after `every`. It gives up once failed looks in a row, `every` apart, have covered
 * `toleratedOutage`; the time the failing calls take comes on top. Only transient gateway errors
 * are tolerated; a bad token, a missing permission or a stop is thrown at once. A look that only
 * reads goes in a `poll`, so the run view folds it into a waiting bar; a write, such as showing
 * comments as being read, stays outside one, so it shows as it happens.
 *
 * ```ts
 * const look = patientLook({ every, toleratedOutage })
 * const current = await poll(description, () => look(() => watch.read()))
 * ```
 */
export function patientLook(options: PatientLookOptions): <Result>(attempt: () => Promise<Result>) => Promise<Result> {
	return async (attempt) => {
		const tolerated = lookBudget(options.toleratedOutage, options.every)
		for (;;) {
			try {
				return await attempt()
			} catch (error) {
				if (!(error instanceof GatewayCallError && error.transient) || !tolerated()) throw error
			}
			await wait(options.every)
		}
	}
}
