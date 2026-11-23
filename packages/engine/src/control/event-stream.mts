import { duration, type Duration } from '@mesh-flow/duration'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

/** How often a stream says it's still there, so a reader can tell a quiet stream from a dead one. */
export const streamHeartbeat: Duration = duration.of('15s')

/** What a stream's `follow` sends with. */
export interface EventSender {
	/**
	 * Sends `event` with `data` as JSON, after everything sent before it. `id` is the stream's place,
	 * which a reader that connects again names in `Last-Event-ID`.
	 */
	readonly send: (event: string, data: unknown, id?: string) => void
	/** Ends the stream. */
	readonly close: () => void
	/** Aborts when the stream ends: closed, or the reader went away. Stop following with it. */
	readonly closed: AbortSignal
}

/**
 * Answers `context` with server-sent events: `follow` sends what it follows until the stream ends, and a
 * `heartbeat` event goes out every `heartbeat` between.
 */
export function eventStream(context: Context, heartbeat: Duration, follow: (sender: EventSender) => void): Response {
	return streamSSE(context, async (stream) => {
		const controller = new AbortController()
		const close = () => {
			controller.abort()
		}
		stream.onAbort(close)
		context.req.raw.signal.addEventListener('abort', close, { once: true })
		// One write at a time. A write to a reader that went away fails; the abort above ends the stream.
		let writing = Promise.resolve()
		const send = (event: string, data: unknown, id?: string) => {
			const message = { event, data: JSON.stringify(data), ...(id === undefined ? {} : { id }) }
			writing = writing.then(() => stream.writeSSE(message)).catch(() => undefined)
		}
		follow({ send, close, closed: controller.signal })
		const timer = setInterval(() => {
			send('heartbeat', {})
		}, heartbeat.to('ms'))
		await new Promise<void>((resolve) => {
			if (controller.signal.aborted) resolve()
			controller.signal.addEventListener(
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
