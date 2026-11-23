/**
 * A refresh that never runs twice at once: asked while it runs, it runs once more after, however
 * often it was asked. For pages that refresh on every change of the engine's, which can come in bursts.
 *
 * ```ts
 * const refresh = refresher(show, signal)
 * onChange(() => refresh(), signal)
 * ```
 */
export function refresher(check: (abortSignal: AbortSignal) => Promise<void>, abortSignal: AbortSignal): () => void {
	let running = false
	let asked = 0
	const run = async (): Promise<void> => {
		running = true
		let checked: number
		do {
			checked = asked
			await check(abortSignal)
		} while (asked !== checked && !abortSignal.aborted)
		running = false
	}
	return () => {
		if (abortSignal.aborted) return
		asked++
		if (!running) void run()
	}
}
