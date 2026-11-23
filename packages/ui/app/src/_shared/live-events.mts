import { followStream } from './follow-stream.mts'

/**
 * What changed in the engine: one run, one sign-in, or anything, after a reconnect or a refresh
 * while the stream is down.
 */
export type Change =
	| { readonly kind: 'run'; readonly id: string }
	| { readonly kind: 'sign-in'; readonly connector: string }
	| { readonly kind: 'all' }

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

/** Anything may have changed: on a connect, and while the stream is down. */
function all(): void {
	changed({ kind: 'all' })
}

/** Follows the engine's event stream until `abortSignal` aborts, for the whole page. */
export function watchEngineEvents(abortSignal: AbortSignal): void {
	followStream('/api/engine/events', {
		on: {
			run: (data) => {
				const id = textField(data, 'id')
				changed(id === undefined ? { kind: 'all' } : { kind: 'run', id })
			},
			'sign-in': (data) => {
				const connector = textField(data, 'connector')
				changed(connector === undefined ? { kind: 'all' } : { kind: 'sign-in', connector })
			},
		},
		connected: all,
		whileDown: all,
		abortSignal,
	})
}

/** The text under `field` in an event's data, or `undefined` for data without one. */
function textField(data: unknown, field: string): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined
	const value: unknown = Reflect.get(data, field)
	return typeof value === 'string' ? value : undefined
}
