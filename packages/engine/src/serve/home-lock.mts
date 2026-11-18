import path from 'node:path'
import { duration, sleep } from '@mesh-flow/duration'
import { lock } from 'proper-lockfile'
import { engineAnswers } from '../control/control-socket.mts'
import { hasErrorCode, messageOf } from '../errors.mts'

/** A lock that hasn't been refreshed for this long belongs to an engine that died. */
const staleAfter = duration.of('5s')

/** How often a running engine refreshes its lock. */
const refreshEvery = duration.of('1s')

/** How often a start looks again at a lock that may be going stale. */
const retryEvery = duration.of('1s')

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
	abortSignal: AbortSignal,
): Promise<() => Promise<void>> {
	const lockfilePath = homeLockPath(home)
	// Long enough for a dead engine's lock to go stale, and two more looks.
	const giveUpAt = retryEvery.after(retryEvery.after(staleAfter.after(new Date())))
	for (;;) {
		abortSignal.throwIfAborted()
		try {
			const release = await lock(home, {
				lockfilePath,
				stale: staleAfter.to('ms'),
				update: refreshEvery.to('ms'),
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
			if ((await engineAnswers(socketPath)) || new Date() > giveUpAt) {
				throw new Error(`An engine is already running on ${home}.`, { cause: error })
			}
			await sleep(retryEvery, abortSignal)
		}
	}
}
