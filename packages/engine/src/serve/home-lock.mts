import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lock } from 'proper-lockfile'
import { engineAnswers } from '../control/control-socket.mts'
import { hasErrorCode, messageOf } from '../errors.mts'

/** A lock that hasn't been refreshed for this long belongs to an engine that died. */
const staleMs = 5_000

/** How often a running engine refreshes its lock. */
const refreshMs = 1_000

/** How often a start looks again at a lock that may be going stale. */
const retryMs = 1_000

/** Long enough for a dead engine's lock to go stale, and two more looks. */
const giveUpAfterMs = staleMs + 2 * retryMs

/** The lock of an engine home. */
export function homeLockPath(home: string): string {
	return path.join(home, 'engine.lock')
}

/**
 * Takes the lock on an engine home, so only one engine reconciles its sandboxes. The lock is a
 * directory the engine keeps fresh. When an engine answers on `socketPath`, the start fails at
 * once. Otherwise the lock is waited on until it goes stale, as one an engine left when it died
 * does, and then taken over.
 * Returns the function that releases it; releasing a lock that was lost does nothing.
 *
 * Two starts that find the same stale lock at the same moment can both take it over: a limit of
 * `proper-lockfile`, and a narrow window next to the socket check that follows.
 */
export async function lockHome(
	home: string,
	socketPath: string,
	log: (message: string) => void,
	signal: AbortSignal,
): Promise<() => Promise<void>> {
	const lockfilePath = homeLockPath(home)
	const giveUpAt = Date.now() + giveUpAfterMs
	for (;;) {
		signal.throwIfAborted()
		try {
			const release = await lock(home, {
				lockfilePath,
				stale: staleMs,
				update: refreshMs,
				onCompromised: (error) => {
					log(`The engine's lock on ${home} was lost: ${messageOf(error)}`)
				},
			})
			return () =>
				release().catch((error: unknown) => {
					if (!hasErrorCode(error, 'ERELEASED')) throw error
				})
		} catch (error) {
			if (!hasErrorCode(error, 'ELOCKED')) throw error
			if ((await engineAnswers(socketPath)) || Date.now() > giveUpAt) {
				throw new Error(`An engine is already running on ${home}.`, { cause: error })
			}
			await delay(retryMs, undefined, { signal }).catch((abort: unknown) => {
				signal.throwIfAborted()
				throw abort
			})
		}
	}
}
