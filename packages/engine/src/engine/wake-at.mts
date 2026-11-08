/** The longest delay `setTimeout` takes; longer ones fire at once. */
const longestDelayMs = 2 ** 31 - 1

/**
 * Calls `wake` at `at`, on the engine's clock, or right away when that has passed. Delays longer
 * than `setTimeout` allows are waited out in steps. Aborting `signal` cancels it.
 */
export function wakeAt(at: Date, wake: () => void, signal: AbortSignal, now: () => Date = () => new Date()): void {
	if (signal.aborted) return
	const remaining = at.getTime() - now().getTime()
	const timer = setTimeout(
		() => {
			signal.removeEventListener('abort', cancel)
			if (remaining > longestDelayMs) wakeAt(at, wake, signal, now)
			else wake()
		},
		Math.max(0, Math.min(remaining, longestDelayMs)),
	)
	const cancel = () => {
		clearTimeout(timer)
	}
	signal.addEventListener('abort', cancel, { once: true })
}
