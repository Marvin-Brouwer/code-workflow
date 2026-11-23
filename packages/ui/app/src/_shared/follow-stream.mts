import { duration, type Duration } from '@mesh-flow/duration'
import { createStore } from '@rooted/store'
import { pollInterval } from './poll.mts'

/**
 * Whether the page hears the engine as things happen: `live` while every stream it follows is up,
 * `reconnecting` while one is down and its page refreshes every `pollInterval` instead.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting'

/** How the streams the page follows are, together, for the shell to show. */
export const liveStatus = createStore<LiveStatus>('connecting')

/**
 * How long a stream may stay quiet before it counts as dead: two of the engine's heartbeats
 * (`streamHeartbeat`, 15 seconds) and a bit. The page can't import it from the engine.
 */
const silenceLimit: Duration = duration.of('35s')

/** How long to wait before connecting again after each failure in a row; the last one repeats. */
const reconnectWaits: readonly Duration[] = [duration.of('1s'), duration.of('2s'), duration.of('5s'), duration.of('10s')]

/** Each followed stream's own status. */
const statuses = new Map<symbol, LiveStatus>()

/** How the streams are together: reconnecting if one is, else connecting if one is, else live. */
function combinedStatus(each: readonly LiveStatus[]): LiveStatus {
	if (each.includes('reconnecting')) return 'reconnecting'
	if (each.includes('connecting')) return 'connecting'
	return 'live'
}

function showStatuses(): void {
	liveStatus.update(() => combinedStatus([...statuses.values()]))
}

/** The JSON in a message's data, or `undefined` when it isn't JSON. */
function jsonOrUndefined(data: unknown): unknown {
	if (typeof data !== 'string') return undefined
	try {
		return JSON.parse(data)
	} catch {
		return undefined
	}
}

/** What to do with a stream. */
export interface FollowOptions {
	/** What to do with each kind of event, with its data as JSON. */
	readonly on: Readonly<Record<string, (data: unknown) => void>>
	/** Called on every connect: the stream starts over from what is now, so drop what came before. */
	readonly connected: () => void
	/** Called right away and every `pollInterval` while the stream is down: fetch what it would have sent. */
	readonly whileDown: () => void
	/** Ends following: closes the stream and stops its timers. */
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
			fallback = setInterval(whileDown, pollInterval.to('ms'))
		}
		const wait = reconnectWaits[Math.min(failures, reconnectWaits.length - 1)] ?? pollInterval
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
				// Data that isn't JSON comes as `undefined`, which every handler checks for.
				handle(jsonOrUndefined(message.data))
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
