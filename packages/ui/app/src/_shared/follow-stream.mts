import { duration, type Duration } from '@mesh-flow/duration'
import { createStore } from '@rooted/store'
import { pollEvery } from './poll.mts'

/**
 * Whether the page hears the engine as things happen: `live` while every stream it follows is up,
 * `reconnecting` while one is down and its page refreshes every two seconds instead.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting'

/** How the streams the page follows are, together, for the shell to show. */
export const liveStatus = createStore<LiveStatus>('connecting')

/** How long a stream may stay quiet before it counts as dead: two heartbeats and a bit. */
const silenceLimit: Duration = duration.of('35s')

/** How long to wait before connecting again after each failure in a row; the last one repeats. */
const reconnectWaits: readonly Duration[] = [duration.of('1s'), duration.of('2s'), duration.of('5s'), duration.of('10s')]

/** Each followed stream's own status. */
const statuses = new Map<symbol, LiveStatus>()

function showStatuses(): void {
	const all = [...statuses.values()]
	liveStatus.update(() => (all.includes('reconnecting') ? 'reconnecting' : all.includes('connecting') ? 'connecting' : 'live'))
}

/** What to do with a stream. */
export interface FollowOptions {
	/** What to do with each kind of event, with its data as JSON. */
	readonly on: Readonly<Record<string, (data: unknown) => void>>
	/** Called on every connect: the stream starts over from what is now, so drop what came before. */
	readonly connected: () => void
	/** Called right away and every two seconds while the stream is down: fetch what it would have sent. */
	readonly whileDown: () => void
	readonly abortSignal: AbortSignal
}

/**
 * Follows the server-sent events at `url` until `abortSignal` aborts. A stream can die without
 * saying so, so it counts as dead when nothing came for a while, heartbeats included. Every
 * connect is a new stream that starts over, never the browser's own resume, so nothing missed
 * while it was down is lost; meanwhile `whileDown` stands in for it.
 */
export function followStream(url: string, options: FollowOptions): void {
	const { on, connected, whileDown, abortSignal } = options
	const key = Symbol(url)
	let failures = 0
	let stream: EventSource | undefined
	let silence: ReturnType<typeof setTimeout> | undefined
	let reconnect: ReturnType<typeof setTimeout> | undefined
	let fallback: ReturnType<typeof setInterval> | undefined

	const status = (now: LiveStatus) => {
		statuses.set(key, now)
		showStatuses()
	}

	const heard = () => {
		clearTimeout(silence)
		silence = setTimeout(down, silenceLimit.to('ms'))
	}

	const stopFallback = () => {
		clearInterval(fallback)
		fallback = undefined
	}

	function down(): void {
		stream?.close()
		stream = undefined
		clearTimeout(silence)
		status('reconnecting')
		if (fallback === undefined) {
			whileDown()
			fallback = setInterval(whileDown, pollEvery.to('ms'))
		}
		const wait = reconnectWaits[Math.min(failures, reconnectWaits.length - 1)] ?? pollEvery
		failures++
		reconnect = setTimeout(connect, wait.to('ms'))
	}

	function connect(): void {
		if (abortSignal.aborted) return
		stream = new EventSource(url)
		stream.addEventListener('open', () => {
			failures = 0
			stopFallback()
			status('live')
			heard()
			connected()
		})
		stream.addEventListener('heartbeat', heard)
		for (const [event, handle] of Object.entries(on))
			stream.addEventListener(event, (message) => {
				heard()
				handle(typeof message.data === 'string' ? JSON.parse(message.data) : undefined)
			})
		// The browser would try again on its own after some errors and not after others: one way for all.
		stream.addEventListener('error', down)
	}

	abortSignal.addEventListener(
		'abort',
		() => {
			stream?.close()
			clearTimeout(silence)
			clearTimeout(reconnect)
			stopFallback()
			statuses.delete(key)
			showStatuses()
		},
		{ once: true },
	)
	status('connecting')
	connect()
}
