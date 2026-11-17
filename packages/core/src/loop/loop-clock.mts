import { findScope } from '../run/run-scope.mts'

/**
 * A loop's own runtime, for `limit({ minutes })`. It stands still while the loop waits on a human,
 * so a slow approval never uses up the agent's budget.
 *
 * Time is read from `Date.now()`, which is right after a sandbox resumes on every backend. The
 * timer only says when to look again.
 */
export interface LoopClock {
	/** Stops the clock while `body` waits on a human. Waits can overlap. */
	whileWaiting<T>(body: () => Promise<T>): Promise<T>
	stop(): void
}

const maxTimerMs = 2 ** 31 - 1

/** The clocks of the loops running in this process, which is one run's runtime. */
const runningClocks = new Set<LoopClock>()

/** Starts a loop's clock. `onExceeded` runs once when `minutes` of runtime are up. */
export function startLoopClock(minutes: number | undefined, onExceeded: () => void): LoopClock {
	const budgetMs = minutes === undefined ? undefined : minutes * 60_000
	let usedMs = 0
	let runningSince: number | undefined = Date.now()
	let waits = 0
	let timer: NodeJS.Timeout | undefined
	let stopped = false

	const arm = () => {
		clearTimeout(timer)
		if (budgetMs === undefined || runningSince === undefined || stopped) return
		const leftMs = budgetMs - usedMs - (Date.now() - runningSince)
		if (leftMs <= 0) {
			stopped = true
			onExceeded()
			return
		}
		// Timers take at most about 24 days; a longer budget just looks again then.
		timer = setTimeout(arm, Math.min(leftMs, maxTimerMs))
	}
	const pause = () => {
		if (runningSince !== undefined) usedMs += Date.now() - runningSince
		runningSince = undefined
		clearTimeout(timer)
	}
	const resume = () => {
		runningSince = Date.now()
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
			clearTimeout(timer)
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
 * {@link waitingOnHuman}. Out of every loop's scope, such as a package manager's fetch through the
 * package proxy, it stops the clock of every loop that runs: the package manager runs in a loop's
 * shell, and the sign-in holds that loop up.
 */
export function waitingOnSignIn<T>(body: () => Promise<T>): Promise<T> {
	return whileClocksWait(findScope()?.loop?.clocks ?? [...runningClocks], body)
}

function whileClocksWait<T>(clocks: readonly LoopClock[], body: () => Promise<T>): Promise<T> {
	return clocks.reduce<() => Promise<T>>((inner, clock) => () => clock.whileWaiting(inner), body)()
}
