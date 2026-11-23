import type { RuntimeEvent } from '@mesh-flow/protocol'
import type { Duration } from '@mesh-flow/duration'
import type { Context } from 'hono'
import type { RunId } from '../runs/run-id.mts'
import type { RunRecord } from '../runs/run-record.mts'
import { eventStream, streamHeartbeat } from './event-stream.mts'

/** What a run's event stream follows. */
export interface RunEventSource {
	/** The run's record. Throws for a run there is none of. */
	readonly get: (id: string) => RunRecord
	readonly events: (id: string) => Promise<RuntimeEvent[]>
	readonly onRunChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
}

/**
 * `GET /runs/:run/events` asked for as `text/event-stream`: one run as it goes, so its view needs
 * no other request. `run` with the record first, and again after each change to it; `event` with
 * each event the runtime sent, numbered from 1 as the stream's id, so a reader that connects again
 * with `Last-Event-ID` gets only the events after it; and `heartbeat` every `heartbeat`. The stream
 * ends when the run is removed.
 */
export function runEventStream(source: RunEventSource, heartbeat: Duration = streamHeartbeat) {
	return (context: Context, run: string): Response => {
		// Before the stream starts, so a run there is none of is answered as an error.
		const { id } = source.get(run)
		const resumeAfter = Number(context.req.header('last-event-id'))
		let sent = Number.isSafeInteger(resumeAfter) && resumeAfter > 0 ? resumeAfter : 0
		return eventStream(context, heartbeat, ({ send, close, closed }) => {
			let shownRecord = ''
			const sendWhatChanged = async () => {
				const record = source.get(id)
				const events = await source.events(id)
				for (; sent < events.length; sent++) send('event', events[sent], String(sent + 1))
				const recordText = JSON.stringify(record)
				if (recordText === shownRecord) return
				shownRecord = recordText
				send('run', record)
			}
			// One look at a time; a change during one means one more look after it.
			let asked = 0
			let looking = false
			const look = async () => {
				asked++
				if (looking) return
				looking = true
				try {
					for (let answered = 0; answered < asked && !closed.aborted;) {
						answered = asked
						await sendWhatChanged()
					}
				} catch {
					// The run is gone.
					close()
				} finally {
					looking = false
				}
			}
			source.onRunChange((changed) => {
				if (changed === id) void look()
			}, closed)
			void look()
		})
	}
}
