import type { CloseOptions } from '../engine/engine.mts'
import { messageOf } from '../errors.mts'

/** The part of `process` shutdown handling uses, so tests can pass their own. */
export interface ShutdownProcess {
	on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown
	on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
	exit(code: number): void
}

export interface HandleShutdownOptions {
	/** Shuts everything down within the deadlines it gets. */
	readonly shutdown: (deadlines: CloseOptions) => Promise<void>
	/** How long pausing may take. Default 30 seconds. */
	readonly pauseTimeoutMs?: number
	/** How long closing the backend may take after that. Default 60 seconds. */
	readonly closeTimeoutMs?: number
	readonly log?: (message: string) => void
	readonly process?: ShutdownProcess
}

/**
 * Shuts down on `SIGINT`, `SIGTERM`, `SIGHUP` or an error nothing caught, then exits. `exit`
 * handlers run synchronously, so everything happens before it.
 *
 * - The first signal starts the shutdown: pause, flush, close.
 * - A second signal skips the pauses that are still going. Closing still removes the sandboxes.
 * - A third exits right away. The next start reconciles what was left.
 *
 * A shutdown that outlives both deadlines is cut off, so the process always ends.
 */
export function handleShutdown(options: HandleShutdownOptions): void {
	const target = options.process ?? process
	const log =
		options.log ??
		((message: string) => {
			console.error(message)
		})
	const pauseTimeoutMs = options.pauseTimeoutMs ?? 30_000
	const closeTimeoutMs = options.closeTimeoutMs ?? 60_000
	const skipPauses = new AbortController()
	let signals = 0
	let started = false

	const begin = (exitCode: number) => {
		if (started) return
		started = true
		const cutOff = setTimeout(
			() => {
				target.exit(exitCode || 1)
			},
			pauseTimeoutMs + closeTimeoutMs + 5_000,
		)
		cutOff.unref()
		const deadlines: CloseOptions = {
			pause: AbortSignal.any([skipPauses.signal, AbortSignal.timeout(pauseTimeoutMs)]),
			close: AbortSignal.timeout(pauseTimeoutMs + closeTimeoutMs),
		}
		options.shutdown(deadlines).then(
			() => {
				target.exit(exitCode)
			},
			(error: unknown) => {
				log(`Shutting down failed: ${messageOf(error)}`)
				target.exit(1)
			},
		)
	}

	const onSignal = () => {
		signals += 1
		if (signals === 1) {
			log('Shutting down: pausing running sandboxes. Press Ctrl+C again to skip the pauses.')
			begin(0)
		} else if (signals === 2) {
			log('Skipping the pauses. Press Ctrl+C once more to exit right away.')
			skipPauses.abort(new Error('The pauses were skipped.'))
		} else {
			target.exit(130)
		}
	}
	const onError = (error: unknown) => {
		log(`Shutting down after an error nothing caught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
		begin(1)
	}

	target.on('SIGINT', onSignal)
	target.on('SIGTERM', onSignal)
	target.on('SIGHUP', onSignal)
	target.on('uncaughtException', onError)
	target.on('unhandledRejection', onError)
}
