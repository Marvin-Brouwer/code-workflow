import { duration, type Duration } from '@mesh-flow/duration'

/** How often pages that change check again. */
export const pollInterval: Duration = duration.of('2s')

/**
 * Runs `check` now and again `interval` after the last one settled, until `abortSignal` aborts,
 * such as the component's `signal` when it unmounts. Polling for now; server-sent events can take
 * its place behind the same data.
 */
export function poll(
	check: (abortSignal: AbortSignal) => Promise<void>,
	abortSignal: AbortSignal,
	interval: Duration = pollInterval,
): void {
	let timer: ReturnType<typeof setTimeout> | undefined
	abortSignal.addEventListener(
		'abort',
		() => {
			clearTimeout(timer)
		},
		{ once: true },
	)
	const next = async (): Promise<void> => {
		await check(abortSignal)
		if (abortSignal.aborted) return
		timer = setTimeout(() => {
			void next()
		}, interval.to('ms'))
	}
	if (!abortSignal.aborted) void next()
}
