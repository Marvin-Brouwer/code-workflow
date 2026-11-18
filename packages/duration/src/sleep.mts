import type { Duration } from './duration.mts'
import { longestTimer } from './longest-timer.mts'

/**
 * Waits for `time` on this process's clock, also when that is longer than `setTimeout` keeps.
 * Aborting `abortSignal` clears the timer and rejects at once with the signal's reason.
 *
 * ```ts
 * await sleep(duration.of('2s'), abortSignal)
 * ```
 */
export async function sleep(time: Duration, abortSignal: AbortSignal): Promise<void> {
	abortSignal.throwIfAborted()
	const due = time.after(new Date()).getTime()
	await new Promise<void>((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined
		const stop = () => {
			clearTimeout(timer)
			reject(abortSignal.reason)
		}
		const step = () => {
			const left = due - Date.now()
			if (left <= 0) {
				abortSignal.removeEventListener('abort', stop)
				resolve()
				return
			}
			timer = setTimeout(step, Math.min(left, longestTimer))
		}
		abortSignal.addEventListener('abort', stop, { once: true })
		step()
	})
}
