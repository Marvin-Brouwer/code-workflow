import type { Duration } from '@mesh-flow/duration'
import type { Context } from 'hono'
import type { RunId } from '../runs/run-id.mts'
import { eventStream, streamHeartbeat } from './event-stream.mts'

/** What the engine's event stream follows: its runs and its sign-ins. */
export interface EngineEventSource {
	readonly onRunChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
	readonly onSignInChange: (listener: (connector: string) => void, abortSignal: AbortSignal) => void
}

/**
 * `GET /events`: server-sent events that say what changed in the engine, not what it is now, so a
 * reader fetches what it shows. `ready` first, so a reader knows at once that the stream is up and
 * every change from here on reaches it, then `run` with `{ id }` after each change to a run,
 * `sign-in` with `{ connector }` after each change to a sign-in, such as a new code to sign in with,
 * and a `heartbeat` every `streamHeartbeat`. A reader that misses heartbeats, or connects again,
 * fetches everything anew.
 */
export function engineEventStream(source: EngineEventSource, heartbeat: Duration = streamHeartbeat) {
	return (context: Context) =>
		eventStream(context, heartbeat, ({ send, closed }) => {
			source.onRunChange((id) => {
				void send({ event: 'run', data: { id } })
			}, closed)
			source.onSignInChange((connector) => {
				void send({ event: 'sign-in', data: { connector } })
			}, closed)
			void send({ event: 'ready', data: {} })
		})
}
