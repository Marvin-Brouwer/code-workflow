import type { CloseDeadlines } from '../engine/engine.mts'
import { messageOf } from '../errors.mts'

/** The part of `process` shutdown handling uses, so tests can pass their own. */
export interface ShutdownProcess {
	on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown
	on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
	exit(code: number): void
}

/** How long pausing may take by default. */
const defaultPauseTimeoutMs = 30_000

/** How long closing the backend may take by default, after the pauses. */
const defaultCloseTimeoutMs = 60_000

/** How long past both deadlines a shutdown may run before the process exits anyway. */
const cutOffGraceMs = 5_000

/** The exit code after a third Ctrl+C: 128 plus SIGINT's number, as shells report it. */
const interruptedExitCode = 130

/** How to shut down, and what to talk to. */
export interface HandleShutdownOptions {
	/** Shuts everything down within the deadlines it gets. */
	readonly shutdown: (deadlines: CloseDeadlines) => Promise<void>
	/** How long pausing may take. Default 30 seconds. */
	readonly pauseTimeoutMs?: number
	/** How long closing the backend may take after that. Default 60 seconds. */
	readonly closeTimeoutMs?: number
	/** Where progress goes. Default: stderr. */
	readonly log?: (message: string) => void
	/** The process to listen to and exit. Default: `process`. */
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
	const pauseTimeoutMs = options.pauseTimeoutMs ?? defaultPauseTimeoutMs
	const closeTimeoutMs = options.closeTimeoutMs ?? defaultCloseTimeoutMs
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
			pauseTimeoutMs + closeTimeoutMs + cutOffGraceMs,
		)
		cutOff.unref()
		const deadlines: CloseDeadlines = {
			pause: AbortSignal.any([skipPauses.signal, AbortSignal.timeout(pauseTimeoutMs)]),
			backend: AbortSignal.timeout(pauseTimeoutMs + closeTimeoutMs),
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
			target.exit(interruptedExitCode)
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
