/**
 * The tokens of one endpoint that aren't in use: a call takes one, and gives back the next one its
 * answer carried. A call that finds none waits until one comes back, so no more calls run at once
 * than the endpoint handed out tokens.
 */
export class TokenPool {
	readonly #free: string[]
	readonly #waiting: Array<(token: string) => void> = []

	constructor(tokens: readonly string[]) {
		this.#free = [...tokens]
	}

	/** A token for the next call, once one is free. */
	async take(abortSignal: AbortSignal): Promise<string> {
		abortSignal.throwIfAborted()
		const free = this.#free.pop()
		if (free !== undefined) return free
		const { promise, resolve, reject } = Promise.withResolvers<string>()
		const onAbort = () => {
			const at = this.#waiting.indexOf(resolve)
			if (at !== -1) this.#waiting.splice(at, 1)
			reject(abortSignal.reason)
		}
		abortSignal.addEventListener('abort', onAbort, { once: true })
		this.#waiting.push(resolve)
		try {
			return await promise
		} finally {
			abortSignal.removeEventListener('abort', onAbort)
		}
	}

	/** Gives back the token an answer carried, to whoever waits for one first. */
	give(token: string): void {
		const next = this.#waiting.shift()
		if (next === undefined) this.#free.push(token)
		else next(token)
	}
}
