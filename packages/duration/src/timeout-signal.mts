import { longestTimer } from './longest-timer.mts'

/**
 * A signal that aborts with a `TimeoutError` after `milliseconds`, like `AbortSignal.timeout`, but
 * also for delays longer than `setTimeout` keeps: those are waited out in steps. The timers don't
 * keep the process alive.
 */
export function timeoutSignal(milliseconds: number): AbortSignal {
	const controller = new AbortController()
	const due = Date.now() + milliseconds
	const step = () => {
		const left = due - Date.now()
		if (left <= 0) {
			controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
			return
		}
		setTimeout(step, Math.min(left, longestTimer)).unref()
	}
	step()
	return controller.signal
}
