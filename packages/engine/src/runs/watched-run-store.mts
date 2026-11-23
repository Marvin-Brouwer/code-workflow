import type { RunId } from './run-id.mts'
import type { RunStore } from './run-store.mts'

/** Says which run was written to, once its record or events are written, for views that follow the runs. */
export interface RunWriteFeed {
	/** Calls `listener` with a run's id after each write to it, until `abortSignal` aborts. */
	readonly onChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
}

/** A run store that tells its feed about every write. */
export interface WatchedRunStore {
	readonly store: RunStore
	readonly writes: RunWriteFeed
}

/**
 * `store`, telling `writes` about each record saved, events appended and run removed, after the
 * write. A listener that reads the run then sees the change.
 */
export function watchedRunStore(store: RunStore): WatchedRunStore {
	const listeners = new Set<(run: RunId) => void>()
	const after = async (run: RunId, writing: Promise<void>): Promise<void> => {
		await writing
		for (const listener of listeners) listener(run)
	}
	return {
		store: Object.freeze<RunStore>({
			...store,
			save: (record) => after(record.id, store.save(record)),
			appendEvents: (id, events) => (events.length === 0 ? Promise.resolve() : after(id, store.appendEvents(id, events))),
			removeRun: (id) => after(id, store.removeRun(id)),
		}),
		writes: Object.freeze<RunWriteFeed>({
			onChange(listener, abortSignal) {
				if (abortSignal.aborted) return
				// The same function twice is two listeners.
				const own = (run: RunId) => {
					listener(run)
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
		}),
	}
}
