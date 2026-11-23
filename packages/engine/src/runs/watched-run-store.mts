import type { RunId } from './run-id.mts'
import type { RunStore } from './run-store.mts'

/** Says which run changed, once its record or events are written, for views that follow the runs. */
export interface RunChangeFeed {
	/** Calls `listener` with a run's id after each change to it is written, until `abortSignal` aborts. */
	readonly listen: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
}

/**
 * `store`, telling `changes` about each record saved, events appended and run removed, after the
 * write. A listener that reads the run then sees the change.
 */
export function watchedRunStore(store: RunStore): { readonly store: RunStore; readonly changes: RunChangeFeed } {
	const target = new EventTarget()
	const after = async (run: RunId, writing: Promise<void>): Promise<void> => {
		await writing
		target.dispatchEvent(new CustomEvent<RunId>('change', { detail: run }))
	}
	return {
		store: Object.freeze<RunStore>({
			...store,
			save: (record) => after(record.id, store.save(record)),
			appendEvents: (id, events) => (events.length === 0 ? Promise.resolve() : after(id, store.appendEvents(id, events))),
			removeRun: (id) => after(id, store.removeRun(id)),
		}),
		changes: Object.freeze<RunChangeFeed>({
			listen(listener, abortSignal) {
				target.addEventListener(
					'change',
					(event) => {
						if (event instanceof CustomEvent && typeof event.detail === 'string') listener(event.detail)
					},
					{ signal: abortSignal },
				)
			},
		}),
	}
}
