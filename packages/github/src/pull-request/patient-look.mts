import { GatewayCallError, wait, type WaitSpec } from '@mesh-flow/core'
import { looksWithin } from './look-interval.mts'

/** What `patientLook` takes. */
export interface PatientLookOptions {
	/** How long to wait before looking again. */
	readonly every: WaitSpec
	/** How long looks may keep failing before the last failure is thrown. */
	readonly toleratedOutage: WaitSpec
}

/**
 * Makes a look at GitHub that a watch can survive failing: when the host can't do a call, because
 * the network or GitHub is down for longer than the host's own retries cover, the look is tried
 * again after `every`, until looks have failed for `toleratedOutage` in a row. Only errors from the
 * gateway are tolerated; anything else, such as a stop, is thrown at once.
 */
export function patientLook(options: PatientLookOptions): <T>(attempt: () => Promise<T>) => Promise<T> {
	const failedLooksTolerated = looksWithin(options.toleratedOutage, options.every)
	return async (attempt) => {
		for (let failedLooks = 0; ; failedLooks++) {
			try {
				return await attempt()
			} catch (error) {
				if (!(error instanceof GatewayCallError) || failedLooks >= failedLooksTolerated) throw error
			}
			await wait(options.every)
		}
	}
}
