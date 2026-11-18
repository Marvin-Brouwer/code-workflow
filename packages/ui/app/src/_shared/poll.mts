import { duration, type Duration } from '@mesh-flow/duration'

/** How often pages that change look again. */
export const pollEvery: Duration = duration.of('2s')

/**
 * Runs `look` now and again every `every` after the last one settled, until `abortSignal` aborts,
 * such as the component's `signal` when it unmounts. Polling for now; server-sent events can take
 * its place behind the same data.
 */
export function poll(look: (abortSignal: AbortSignal) => Promise<void>, abortSignal: AbortSignal, every: Duration = pollEvery): void {
	const next = async (): Promise<void> => {
		await look(abortSignal)
		if (abortSignal.aborted) return
		const timer = setTimeout(() => {
			void next()
		}, every.to('ms'))
		abortSignal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
			},
			{ once: true },
		)
	}
	if (!abortSignal.aborted) void next()
}
