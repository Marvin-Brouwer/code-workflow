/**
 * Runs calls with the same key one after another, and calls with different keys side by side. A
 * call that fails doesn't stop the ones queued after it.
 */
export function oneAtATime(): <T>(key: string, call: () => Promise<T>) => Promise<T> {
	const lastOn = new Map<string, Promise<unknown>>()
	return async (key, call) => {
		const turn = (lastOn.get(key) ?? Promise.resolve()).catch(() => undefined).then(call)
		lastOn.set(key, turn)
		try {
			return await turn
		} finally {
			if (lastOn.get(key) === turn) lastOn.delete(key)
		}
	}
}
