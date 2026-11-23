import type { Duration } from '@mesh-flow/duration'
import type { RuntimeEvent } from '@mesh-flow/protocol'
import type { Context } from 'hono'
import { EngineError } from '../engine/engine-error.mts'
import type { RunId } from '../runs/run-id.mts'
import type { RunRecord } from '../runs/run-record.mts'
import { eventStream, streamHeartbeat } from './event-stream.mts'

/** What a run's event stream follows. */
export interface RunEventSource {
	/** The run's record, or `undefined` when there is none of that id, such as after it was removed. */
	readonly find: (id: string) => RunRecord | undefined
	readonly events: (id: string) => Promise<RuntimeEvent[]>
	readonly onRunChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
	readonly onSignInChange: (listener: (connector: string) => void, abortSignal: AbortSignal) => void
}

/**
 * `GET /runs/:run/events` asked for as `text/event-stream`: one run as it goes, so its view needs
 * no other stream. `run` with the record first, and again after each change to it; `run-event` with
 * each event the runtime sent, numbered from 1 as the stream's id, so a reader that connects again
 * with `Last-Event-ID` gets only the events after it; `sign-in` with `{ connector }` after each
 * change to a sign-in, which the run may wait on; and a `heartbeat` every `streamHeartbeat`. The
 * stream ends when the run is removed.
 */
export function runEventStream(source: RunEventSource, heartbeat: Duration = streamHeartbeat) {
	return (context: Context, run: string): Response => {
		// Before the stream starts, so a run there is none of is answered as an error.
		const found = source.find(run)
		if (found === undefined) throw new EngineError('not-found', `There is no run ${run}.`)
		const { id } = found
		const resumeAfter = Number(context.req.header('last-event-id'))
		let sent = Number.isSafeInteger(resumeAfter) && resumeAfter > 0 ? resumeAfter : 0
		return eventStream(context, heartbeat, ({ send, close, closed }) => {
			let shownRecord = ''
			const sendWhatChanged = async () => {
				const record = source.find(id)
				if (record === undefined) {
					close()
					return
				}
				const events = await source.events(id)
				for (; sent < events.length; sent++) send({ event: 'run-event', data: events[sent], id: String(sent + 1) })
				const recordText = JSON.stringify(record)
				if (recordText === shownRecord) return
				shownRecord = recordText
				send({ event: 'run', data: record })
			}
			// One look at a time; a change during one means one more look after it.
			let asked = 0
			let looking = false
			const look = async () => {
				asked++
				if (looking) return
				looking = true
				for (let answered = 0; answered < asked && !closed.aborted;) {
					answered = asked
					// The events can't be read, such as a run removed between the two reads: end the
					// stream, and the reader connecting again is answered with what went wrong.
					await sendWhatChanged().catch(close)
				}
				looking = false
			}
			source.onRunChange((changed) => {
				if (changed === id) void look()
			}, closed)
			source.onSignInChange((connector) => {
				send({ event: 'sign-in', data: { connector } })
			}, closed)
			void look()
		})
	}
}
