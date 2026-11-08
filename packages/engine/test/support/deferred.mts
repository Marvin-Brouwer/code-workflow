/** A promise and the function that resolves it, for holding a step of a test until it's let go. */
export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	const resolvers: Array<(value: T) => void> = []
	const promise = new Promise<T>((resolve) => {
		resolvers.push(resolve)
	})
	return {
		promise,
		resolve: (value) => {
			for (const resolve of resolvers) resolve(value)
		},
	}
}
