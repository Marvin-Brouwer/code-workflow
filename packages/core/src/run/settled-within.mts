/** Waits at most `ms` for `promise`. Says whether it settled in time; a rejection counts as settled. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(resolve, ms, false)
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
