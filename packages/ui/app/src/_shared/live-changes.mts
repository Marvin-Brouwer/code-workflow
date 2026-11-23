import { duration, type Duration } from '@mesh-flow/duration'
import { createStore } from '@rooted/store'
import { pollEvery } from './poll.mts'

/**
 * Whether the page hears the engine's changes as they happen: `live` while the change stream is up,
 * `reconnecting` while it's down and pages refresh every two seconds instead.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting'

/** The change stream's status, for the shell to show. */
export const liveStatus = createStore<LiveStatus>('connecting')

/** What changed: one run, or anything, after a reconnect or a refresh while the stream is down. */
export type Change = { readonly kind: 'run'; readonly id: string } | { readonly kind: 'all' }

/** How long the stream may stay quiet before it counts as dead: two heartbeats and a bit. */
const silenceLimit: Duration = duration.of('35s')

/** How long to wait before connecting again after each failure in a row; the last one repeats. */
const reconnectWaits: readonly Duration[] = [duration.of('1s'), duration.of('2s'), duration.of('5s'), duration.of('10s')]

const listeners = new Set<(change: Change) => void>()

/** Calls `listener` with each change until `abortSignal` aborts, such as the component's `signal`. */
export function onChange(listener: (change: Change) => void, abortSignal: AbortSignal): void {
	if (abortSignal.aborted) return
	const own = (change: Change) => {
		listener(change)
	}
	listeners.add(own)
	abortSignal.addEventListener(
		'abort',
		() => {
			listeners.delete(own)
		},
		{ once: true },
	)
}

function changed(change: Change): void {
	for (const listener of listeners) listener(change)
}

/**
 * Follows the engine's change stream until `abortSignal` aborts, for the whole page. A stream can
 * die without saying so, so it counts as dead when no heartbeat came for a while. While it's down,
 * pages refresh every two seconds, and every (re)connect refreshes them all, so a change missed
 * while down is never lost.
 */
export function watchChanges(abortSignal: AbortSignal): void {
	let failures = 0
	let stream: EventSource | undefined
	let silence: ReturnType<typeof setTimeout> | undefined
	let reconnect: ReturnType<typeof setTimeout> | undefined
	let fallback: ReturnType<typeof setInterval> | undefined

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
		liveStatus.update(() => 'reconnecting')
		fallback ??= setInterval(() => {
			changed({ kind: 'all' })
		}, pollEvery.to('ms'))
		const wait = reconnectWaits[Math.min(failures, reconnectWaits.length - 1)] ?? pollEvery
		failures++
		reconnect = setTimeout(connect, wait.to('ms'))
	}

	function connect(): void {
		if (abortSignal.aborted) return
		stream = new EventSource('/api/engine/changes')
		stream.addEventListener('ready', () => {
			failures = 0
			stopFallback()
			liveStatus.update(() => 'live')
			heard()
			changed({ kind: 'all' })
		})
		stream.addEventListener('heartbeat', heard)
		stream.addEventListener('run', (event) => {
			heard()
			const id = runIdOf(event.data)
			changed(id === undefined ? { kind: 'all' } : { kind: 'run', id })
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
		},
		{ once: true },
	)
	connect()
}

/** The run id a `run` event names, or `undefined` for data that doesn't name one. */
function runIdOf(data: unknown): string | undefined {
	if (typeof data !== 'string') return undefined
	const parsed: unknown = JSON.parse(data)
	return typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : undefined
}
