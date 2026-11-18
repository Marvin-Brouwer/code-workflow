import { duration } from '@mesh-flow/duration'

/** The longest delay `setTimeout` takes; longer ones fire at once. */
const longestDelay = duration({ milliseconds: 2 ** 31 - 1 })

/**
 * Calls `wake` at `at`, on the engine's clock, or right away when that has passed. Delays longer
 * than `setTimeout` allows are waited out in steps. Aborting `signal` cancels it.
 */
export function wakeAt(at: Date, wake: () => void, signal: AbortSignal, now: () => Date = () => new Date()): void {
	if (signal.aborted) return
	const current = now()
	const remaining = at > current ? duration.between(current, at) : duration({})
	const inSteps = remaining.to('ms') > longestDelay.to('ms')
	const timer = setTimeout(
		() => {
			signal.removeEventListener('abort', cancel)
			if (inSteps) wakeAt(at, wake, signal, now)
			else wake()
		},
		(inSteps ? longestDelay : remaining).to('ms'),
	)
	const cancel = () => {
		clearTimeout(timer)
	}
	signal.addEventListener('abort', cancel, { once: true })
}
