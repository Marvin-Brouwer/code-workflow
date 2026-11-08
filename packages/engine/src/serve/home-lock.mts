import path from 'node:path'
import { lock } from 'proper-lockfile'
import { hasErrorCode, messageOf } from '../errors.mts'

/** A lock that hasn't been refreshed for this long belongs to an engine that died. */
const staleMs = 5_000

/** How often a running engine refreshes its lock. */
const refreshMs = 1_000

/** How often, and how many times, a start tries again, so it outlasts a dead engine's lock. */
const retryMs = 1_000
const retries = Math.ceil(staleMs / retryMs) + 2

/**
 * Takes the lock on an engine home, so only one engine reconciles its sandboxes. The lock is a
 * directory that the engine keeps fresh; one an engine left when it died goes stale and is taken
 * over. Returns the function that releases it.
 */
export async function lockHome(home: string, log: (message: string) => void): Promise<() => Promise<void>> {
	try {
		return await lock(home, {
			lockfilePath: path.join(home, 'engine.lock'),
			stale: staleMs,
			update: refreshMs,
			retries: { retries, factor: 1, minTimeout: retryMs, maxTimeout: retryMs },
			onCompromised: (error) => {
				log(`The engine's lock on ${home} was lost: ${messageOf(error)}`)
			},
		})
	} catch (error) {
		if (hasErrorCode(error, 'ELOCKED')) throw new Error(`An engine is already running on ${home}.`, { cause: error })
		throw error
	}
}
