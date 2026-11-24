import { followStream } from './follow-stream.mts'

/**
 * What changed in the engine: one run, one sign-in, or anything, after a reconnect or a refresh
 * while the stream is down.
 */
export type EngineChange =
	| { readonly kind: 'run'; readonly id: string }
	| { readonly kind: 'sign-in'; readonly connector: string }
	| { readonly kind: 'all' }

const listeners = new Set<(change: EngineChange) => void>()

/** Calls `listener` with each change until `abortSignal` aborts, such as the component's `signal`. */
export function onChange(listener: (change: EngineChange) => void, abortSignal: AbortSignal): void {
	if (abortSignal.aborted) return
	// The same function twice is two listeners.
	const own = (change: EngineChange) => {
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

/** Tells every listener about `change`: from the engine's stream, or from a page's own stream. */
export function announce(change: EngineChange): void {
	for (const listener of listeners) listener(change)
}

/** Anything may have changed: on a connect, and while the stream is down. */
function changedEverything(): void {
	announce({ kind: 'all' })
}

/** The shell's stream: how long the page lives, and what ends the stream while it's open. */
interface ShellStream {
	readonly abortSignal: AbortSignal
	/** Ends the open stream; `undefined` while none is open, as while a page follows its own. */
	following: AbortController | undefined
}

/** The page's one shell stream, once `watchEngineEvents` started it, and how many pages follow a stream of their own. */
let shell: ShellStream | undefined
let ownStreams = 0

function followEngine(): void {
	if (shell === undefined || shell.abortSignal.aborted || shell.following !== undefined) return
	const following = new AbortController()
	shell.following = following
	followStream('/api/engine/events', {
		on: {
			run: (data) => {
				const id = textField(data, 'id')
				announce(id === undefined ? { kind: 'all' } : { kind: 'run', id })
			},
			'sign-in': (data) => {
				const connector = textField(data, 'connector')
				announce(connector === undefined ? { kind: 'all' } : { kind: 'sign-in', connector })
			},
		},
		connected: changedEverything,
		whileDown: changedEverything,
		abortSignal: AbortSignal.any([shell.abortSignal, following.signal]),
	})
}

/**
 * Follows the engine's event stream until `abortSignal` aborts, for the whole page, except while a
 * page follows a stream of its own (see `withOwnStream`).
 */
export function watchEngineEvents(abortSignal: AbortSignal): void {
	shell = { abortSignal, following: undefined }
	if (ownStreams === 0) followEngine()
}

/**
 * Closes the engine's event stream until `abortSignal` aborts, for a page that follows a stream of
 * its own that says all it needs, such as a run's. A browser keeps only six connections to the UI's
 * address, and a stream holds one for as long as it's open, so each tab holds one stream at most;
 * the page passes what its own stream says on with `announce`.
 */
export function withOwnStream(abortSignal: AbortSignal): void {
	if (abortSignal.aborted) return
	ownStreams++
	shell?.following?.abort()
	if (shell !== undefined) shell.following = undefined
	abortSignal.addEventListener(
		'abort',
		() => {
			ownStreams--
			if (ownStreams === 0) followEngine()
		},
		{ once: true },
	)
}

/** The text under `field` in an event's data, or `undefined` for data without one. */
function textField(data: unknown, field: string): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined
	const value: unknown = Reflect.get(data, field)
	return typeof value === 'string' ? value : undefined
}
