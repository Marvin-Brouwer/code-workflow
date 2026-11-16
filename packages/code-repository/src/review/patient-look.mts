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
 * Makes a look at a code host that a watch can survive failing: when the host can't do a call, because
 * the network or the code host is down for longer than the host's own retries cover, the look is tried
 * again after `every`. It gives up once `toleratedOutage / every` looks in a row have failed; the
 * time the failing calls take comes on top. Only transient gateway errors are tolerated; a bad
 * token, a missing permission or a stop is thrown at once.
 */
export function patientLook(options: PatientLookOptions): <T>(attempt: () => Promise<T>) => Promise<T> {
	const failedLooksTolerated = looksWithin(options.toleratedOutage, options.every)
	return async (attempt) => {
		for (let failedLooks = 0; ; failedLooks++) {
			try {
				return await attempt()
			} catch (error) {
				if (!(error instanceof GatewayCallError && error.transient) || failedLooks >= failedLooksTolerated) throw error
			}
			await wait(options.every)
		}
	}
}
