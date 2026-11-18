import type { Duration } from './duration.mts'
import { longestTimer } from './longest-timer.mts'

/**
 * A signal that aborts with a `TimeoutError` after `time`, as `AbortSignal.timeout` does, also for
 * delays longer than `setTimeout` keeps: those are waited out in steps. Like `AbortSignal.timeout`,
 * it goes by the process's own clock, which a change of the system time doesn't move, and its
 * timers don't keep the process alive.
 */
export function timeoutSignal(time: Duration): AbortSignal {
	const total = time.to('ms')
	const controller = new AbortController()
	const due = performance.now() + total
	const step = () => {
		const left = due - performance.now()
		if (left <= 0) {
			controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
			return
		}
		setTimeout(step, Math.min(left, longestTimer)).unref()
	}
	// Never at once, even for no time at all, as `AbortSignal.timeout` does.
	setTimeout(step, Math.min(total, longestTimer)).unref()
	return controller.signal
}
