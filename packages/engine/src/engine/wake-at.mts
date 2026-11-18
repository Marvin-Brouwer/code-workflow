import { duration } from '@mesh-flow/duration'

/** The longest delay `setTimeout` takes; longer ones fire at once. */
const longestDelay = duration({ milliseconds: 2 ** 31 - 1 })

/**
 * Calls `wake` at `at`, on the engine's clock, or right away when that has passed. Delays longer
 * than `setTimeout` allows are waited out in steps. Aborting `abortSignal` cancels it.
 */
export function wakeAt(at: Date, wake: () => void, abortSignal: AbortSignal, now: () => Date = () => new Date()): void {
	if (abortSignal.aborted) return
	const current = now()
	const inSteps = at > longestDelay.after(current)
	const remaining = at > current ? duration.between(current, at) : duration({})
	const timer = setTimeout(
		() => {
			abortSignal.removeEventListener('abort', cancel)
			if (inSteps) wakeAt(at, wake, abortSignal, now)
			else wake()
		},
		(inSteps ? longestDelay : remaining).to('ms'),
	)
	const cancel = () => {
		clearTimeout(timer)
	}
	abortSignal.addEventListener('abort', cancel, { once: true })
}
