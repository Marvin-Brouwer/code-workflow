import { abortable } from './abortable.mts'

type Remove = (signal: AbortSignal) => Promise<void>

/**
 * What one backend instance has running, so `close` can stop all of it.
 *
 * Every call a backend makes runs on {@link BackendLifetime.bind}, which also aborts on close.
 * Every running sandbox is tracked with the function that removes it, and cleanup that runs in the
 * background is kept with {@link BackendLifetime.keep}, so `close` waits for it.
 */
export class BackendLifetime {
	readonly #closed = new AbortController()
	readonly #running = new Map<string, Remove>()
	readonly #starting = new Set<string>()
	readonly #pending = new Set<Promise<unknown>>()
	/** Set once `close` is called; the signal its cleanup runs on. */
	#closeSignal: AbortSignal | undefined

	/** Aborts on close only: for shared work that no single caller should be able to stop. */
	get closing(): AbortSignal {
		return this.#closed.signal
	}

	/** The caller's signal, aborted on close as well. Throws once the backend is closed. */
	bind(signal: AbortSignal): AbortSignal {
		if (this.#closeSignal !== undefined) throw new Error('This sandbox backend is closed.')
		return AbortSignal.any([signal, this.#closed.signal])
	}

	/** Work that has to finish before `close` returns, such as removing a sandbox that came too late. */
	keep<T>(work: Promise<T>): Promise<T> {
		this.#pending.add(work)
		const forget = () => this.#pending.delete(work)
		work.then(forget, forget)
		return work
	}

	/**
	 * Registers a running sandbox, so `close` removes it. A sandbox that arrives after close is
	 * removed right away, and this throws.
	 */
	track(id: string, remove: Remove): void {
		if (this.#closeSignal !== undefined) {
			this.keep(remove(this.#closeSignal)).catch(() => undefined)
			throw new Error('This sandbox backend is closed.')
		}
		this.#running.set(id, remove)
	}

	/** Whether a sandbox with this id is running on this backend now. */
	tracks(id: string): boolean {
		return this.#running.has(id)
	}

	/**
	 * Runs `start` for a sandbox that must not run twice, such as a resume. Throws when it already
	 * runs here, or another start of it is still going.
	 */
	async startOnce<T>(id: string, start: () => Promise<T>): Promise<T> {
		if (this.#running.has(id) || this.#starting.has(id)) throw new Error(`The sandbox ${id} is already running.`)
		this.#starting.add(id)
		try {
			return await start()
		} finally {
			this.#starting.delete(id)
		}
	}

	/** Forgets a sandbox that was paused, or removed some other way. */
	untrack(id: string): void {
		this.#running.delete(id)
	}

	/** Removes a tracked sandbox now, then forgets it. */
	async destroy(id: string, signal: AbortSignal): Promise<void> {
		await this.#running.get(id)?.(this.bind(signal))
		this.#running.delete(id)
	}

	/**
	 * Aborts calls in flight, removes every tracked sandbox, and waits for the cleanup that is
	 * still going, as long as `signal` allows. Failures don't stop the others; they are thrown
	 * together at the end.
	 */
	async close(signal: AbortSignal): Promise<void> {
		this.#closeSignal = signal
		this.#closed.abort(new Error('The sandbox backend was closed.'))
		const removals = [...this.#running].map(async ([id, remove]) => {
			await remove(signal)
			this.#running.delete(id)
		})
		const failures = (await Promise.allSettled(removals))
			.filter((result) => result.status === 'rejected')
			.map((result) => result.reason as unknown)
		await this.#settlePending(signal)
		if (failures.length > 0) throw new AggregateError(failures, 'Some sandboxes could not be removed on close.')
	}

	/** Pending work can add more pending work, so this waits until none is left. */
	async #settlePending(signal: AbortSignal): Promise<void> {
		while (this.#pending.size > 0 && !signal.aborted) {
			await abortable(Promise.allSettled(this.#pending), signal).catch(() => undefined)
		}
	}
}
