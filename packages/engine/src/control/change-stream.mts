import { duration, type Duration } from '@mesh-flow/duration'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { RunId } from '../runs/run-id.mts'

/** How often the change stream says it's still there, so a reader can tell a quiet stream from a dead one. */
export const changeHeartbeat: Duration = duration.of('15s')

/** What the change stream follows: the engine's runs. */
export interface ChangeSource {
	readonly onRunChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => void
}

/**
 * `GET /changes`: server-sent events that say what changed, not what it is now, so a reader fetches
 * what it shows. `ready` first, then `run` with `{ id }` after each change to a run, and `heartbeat`
 * every `heartbeat`. A reader that misses heartbeats, or connects again, fetches everything anew.
 */
export function changeStream(source: ChangeSource, heartbeat: Duration = changeHeartbeat) {
	return (c: Context) =>
		streamSSE(c, async (stream) => {
			const closed = new AbortController()
			stream.onAbort(() => {
				closed.abort()
			})
			c.req.raw.signal.addEventListener(
				'abort',
				() => {
					closed.abort()
				},
				{ once: true },
			)
			// One write at a time. A write to a reader that went away fails; the abort above ends the stream.
			let writing = Promise.resolve()
			const send = (event: 'ready' | 'run' | 'heartbeat', data: object) => {
				writing = writing.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined)
			}
			source.onRunChange((id) => {
				send('run', { id })
			}, closed.signal)
			send('ready', {})
			const timer = setInterval(() => {
				send('heartbeat', {})
			}, heartbeat.to('ms'))
			await new Promise<void>((resolve) => {
				if (closed.signal.aborted) resolve()
				closed.signal.addEventListener(
					'abort',
					() => {
						resolve()
					},
					{ once: true },
				)
			})
			clearInterval(timer)
			await writing
		})
}
