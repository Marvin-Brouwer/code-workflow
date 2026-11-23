import type { RunEvent, RunRecord } from '../_shared/runs.mts'

/** What the run page shows: the run's record, once there is one, and its events in order. */
export interface RunSnapshot {
	readonly record: RunRecord | undefined
	readonly events: readonly RunEvent[]
}

/** What the run page knows of a run, from its stream and from the fetches that stand in for it. */
export interface RunFeed {
	/** The stream connected again and starts over: what came before goes, and fetches under way don't count. */
	readonly connected: () => void
	readonly streamedRecord: (record: RunRecord) => void
	readonly streamedEvent: (event: RunEvent) => void
	/** Call when a fetch starts. Give what it got to `fetched` with the number this returns. */
	readonly fetchStarted: () => number
	/**
	 * What a fetch got, in place of all there was, unless the stream connected since it started:
	 * then the stream is ahead of it, and it is dropped. Says whether it was taken.
	 */
	readonly fetched: (started: number, snapshot: { readonly record: RunRecord; readonly events: readonly RunEvent[] }) => boolean
	readonly snapshot: () => RunSnapshot
}

/** A run's record and events as its stream and the fetches while it's down bring them. */
export function runFeed(): RunFeed {
	let connections = 0
	let record: RunRecord | undefined
	let events: RunEvent[] = []
	return {
		connected() {
			connections++
			events = []
		},
		streamedRecord(streamed) {
			record = streamed
		},
		streamedEvent(streamed) {
			events.push(streamed)
		},
		fetchStarted: () => connections,
		fetched(started, snapshot) {
			if (started !== connections) return false
			record = snapshot.record
			events = [...snapshot.events]
			return true
		},
		snapshot: () => ({ record, events }),
	}
}
