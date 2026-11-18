import type { Duration } from '@mesh-flow/duration'

/** Waits at most `time` for `promise`. Says whether it settled in time; a rejection counts as settled. */
export async function settledWithin(promise: Promise<unknown>, time: Duration): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(resolve, time.to('ms'), false)
	})
	try {
		return await Promise.race([
			promise.then(
				() => true as const,
				() => true as const,
			),
			timedOut,
		])
	} finally {
		clearTimeout(timer)
	}
}
