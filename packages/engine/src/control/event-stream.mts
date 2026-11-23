import { duration, type Duration } from '@mesh-flow/duration'
import type { Context } from 'hono'
import { streamSSE, type SSEMessage } from 'hono/streaming'

/** How often a stream says it's still there, so a reader can tell a quiet stream from a dead one. */
export const streamHeartbeat: Duration = duration.of('15s')

/**
 * How many messages may wait for a reader that is connected but doesn't read. Past it the stream
 * ends, and the reader connects again and starts over, rather than the engine holding them all.
 */
const queueLimit = 1000

/** One message of a stream. */
export interface StreamMessage {
	readonly event: string
	readonly data: unknown
	/** The stream's place, which a reader that connects again names in `Last-Event-ID`. */
	readonly id?: string | undefined
}

/** What a stream's `follow` sends with. */
export interface EventSender {
	/**
	 * Sends `message`, its data as JSON, after everything sent before it. Settles once it's written,
	 * or couldn't be: await it while sending many, so they don't all wait at once.
	 */
	readonly send: (message: StreamMessage) => Promise<void>
	/** Ends the stream. */
	readonly close: () => void
	/** Aborts when the stream ends: closed, or the reader went away. Stop following with it. */
	readonly closed: AbortSignal
}

/** `message` as Hono writes it, its data as JSON. */
function sseMessage({ event, data, id }: StreamMessage): SSEMessage {
	if (id === undefined) return { event, data: JSON.stringify(data) }
	return { event, data: JSON.stringify(data), id }
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
		let waiting = 0
		const send = async (message: StreamMessage) => {
			if (controller.signal.aborted) return
			if (waiting >= queueLimit) {
				close()
				return
			}
			waiting++
			writing = writing
				.then(() => stream.writeSSE(sseMessage(message)))
				.catch(() => undefined)
				.finally(() => {
					waiting--
				})
			await writing
		}
		follow({ send, close, closed: controller.signal })
		const timer = setInterval(() => {
			void send({ event: 'heartbeat', data: {} })
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
