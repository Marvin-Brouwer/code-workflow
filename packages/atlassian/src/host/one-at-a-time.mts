/**
 * Runs calls that share a key one after the other, in the order they came, and calls with
 * different keys side by side: for a read, a write and a record of it that must not interleave.
 * A call that fails lets the next one run.
 */
export function oneAtATimePerKey(): <T>(key: string, call: () => Promise<T>) => Promise<T> {
	const tails = new Map<string, Promise<unknown>>()
	return (key, call) => {
		const previous = tails.get(key) ?? Promise.resolve()
		const running = previous.then(call, call)
		const tail = running.catch(() => undefined)
		tails.set(key, tail)
		// Forgotten once nothing waits behind it, so keys don't pile up.
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key)
		})
		return running
	}
}
