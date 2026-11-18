import { duration, sleep, type Duration } from '@mesh-flow/duration'
import { findScope } from '../run/run-scope.mts'

/**
 * A loop's own runtime, for `limit({ time })`. It stands still while the loop waits on a human, so
 * a slow approval never uses up the agent's budget: after each wait, the loop's deadline moves on
 * by as long as the wait took.
 *
 * Time is read from the clock, which is right after a sandbox resumes on every backend. The timer
 * only says when to look again.
 */
export interface LoopClock {
	/** Stops the clock while `body` waits on a human. Waits can overlap. */
	whileWaiting<T>(body: () => Promise<T>): Promise<T>
	stop(): void
}

/** The clocks of the loops running in this process, which is one run's runtime. */
const runningClocks = new Set<LoopClock>()

/** Starts a loop's clock. `onExceeded` runs once, with the budget, when `budget` of runtime is up. */
export function startLoopClock(budget: Duration | undefined, onExceeded: (budget: Duration) => void): LoopClock {
	let deadline = budget?.after(new Date())
	let waitingSince: Date | undefined
	let waits = 0
	let looking: AbortController | undefined
	let stopped = false

	const arm = () => {
		looking?.abort()
		if (budget === undefined || deadline === undefined || waitingSince !== undefined || stopped) return
		const now = new Date()
		if (now >= deadline) {
			stopped = true
			onExceeded(budget)
			return
		}
		looking = new AbortController()
		// Stopped by aborting `looking`, which is not a failure.
		void sleep(duration.between(now, deadline), looking.signal).then(arm, () => undefined)
	}
	const pause = () => {
		waitingSince = new Date()
		looking?.abort()
	}
	const resume = () => {
		const now = new Date()
		// A clock set back during the wait leaves the deadline where it was.
		if (deadline !== undefined && waitingSince !== undefined && now > waitingSince)
			deadline = duration.between(waitingSince, now).after(deadline)
		waitingSince = undefined
		arm()
	}
	arm()

	const clock: LoopClock = {
		async whileWaiting(body) {
			if (waits++ === 0) pause()
			try {
				return await body()
			} finally {
				if (--waits === 0) resume()
			}
		},
		stop() {
			stopped = true
			looking?.abort()
			runningClocks.delete(clock)
		},
	}
	runningClocks.add(clock)
	return clock
}

/**
 * Runs `body`, a wait on a human, with the clocks of the loops it runs in stopped: the current loop
 * and every loop around it, such as the one whose agent called this agent as a tool. Outside a loop
 * it just runs it.
 */
export function waitingOnHuman<T>(body: () => Promise<T>): Promise<T> {
	return whileClocksWait(findScope()?.loop?.clocks ?? [], body)
}

/**
 * Runs `body`, a wait for the user to sign in, with the clocks of the loops it runs in stopped, as
 * {@link waitingOnHuman}. Out of the run's scope altogether, such as a package manager's fetch
 * through the package proxy, it stops the clock of every loop that runs when the wait starts: the
 * package manager runs in a loop's shell, and the sign-in holds that loop up.
 */
export function waitingOnSignIn<T>(body: () => Promise<T>): Promise<T> {
	const scope = findScope()
	return whileClocksWait(scope === undefined ? [...runningClocks] : (scope.loop?.clocks ?? []), body)
}

/** Runs `body` with each of `clocks` stopped while it runs, by nesting their `whileWaiting`. */
function whileClocksWait<T>(clocks: readonly LoopClock[], body: () => Promise<T>): Promise<T> {
	return clocks.reduce<() => Promise<T>>((inner, clock) => () => clock.whileWaiting(inner), body)()
}
