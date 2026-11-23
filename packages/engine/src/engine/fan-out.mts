/** Listeners that each hear every value announced, until their own abort signal aborts. */
export interface FanOut<Value> {
	/** Calls `listener` with each value announced until `abortSignal` aborts. The same function twice is two listeners. */
	readonly onChange: (listener: (value: Value) => void, abortSignal: AbortSignal) => void
	/** Tells every listener about `value`. */
	readonly announce: (value: Value) => void
}

/** A fan-out to listeners that come and go with their abort signals. */
export function fanOut<Value>(): FanOut<Value> {
	const listeners = new Set<(value: Value) => void>()
	return {
		onChange(listener, abortSignal) {
			if (abortSignal.aborted) return
			const own = (value: Value) => {
				listener(value)
			}
			listeners.add(own)
			abortSignal.addEventListener(
				'abort',
				() => {
					listeners.delete(own)
				},
				{ once: true },
			)
		},
		announce(value) {
			for (const listener of listeners) listener(value)
		},
	}
}
