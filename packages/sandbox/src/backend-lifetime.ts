type Remove = (signal: AbortSignal) => Promise<void>;

/**
 * What one backend instance has running, so `close` can stop all of it.
 *
 * Every call a backend makes runs on {@link BackendLifetime.signal}, which also aborts on close.
 * Every running sandbox is tracked with the function that removes it.
 */
export class BackendLifetime {
    readonly #closed = new AbortController();
    readonly #running = new Map<string, Remove>();

    /** Aborts on close only: for shared work that no single caller should be able to stop. */
    get closing(): AbortSignal {
        return this.#closed.signal;
    }

    /** The caller's signal, aborted on close as well. Throws once the backend is closed. */
    signal(signal: AbortSignal): AbortSignal {
        if (this.#closed.signal.aborted) throw new Error('This sandbox backend is closed.');
        return AbortSignal.any([signal, this.#closed.signal]);
    }

    track(id: string, remove: Remove): void {
        this.#running.set(id, remove);
    }

    untrack(id: string): void {
        this.#running.delete(id);
    }

    /**
     * Aborts calls in flight, then removes every tracked sandbox. Failures don't stop the others;
     * they are thrown together at the end.
     */
    async close(signal: AbortSignal): Promise<void> {
        this.#closed.abort(new Error('The sandbox backend was closed.'));
        const removals = [...this.#running].map(async ([id, remove]) => {
            await remove(signal);
            this.#running.delete(id);
        });
        const failures = (await Promise.allSettled(removals))
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason as unknown);
        if (failures.length > 0) throw new AggregateError(failures, 'Some sandboxes could not be removed on close.');
    }
}
