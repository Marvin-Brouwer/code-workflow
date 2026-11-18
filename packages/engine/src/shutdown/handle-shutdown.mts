import { duration, type Duration } from '@mesh-flow/duration'
import type { CloseDeadlines } from '../engine/engine.mts'
import { messageOf } from '../errors.mts'

/** The part of `process` shutdown handling uses, so tests can pass their own. */
export interface ShutdownProcess {
	on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown
	on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
	exit(code: number): void
}

/** How long pausing may take by default. */
const defaultPauseTimeout = duration.of('30s')

/** How long closing the backend may take by default, after the pauses. */
const defaultCloseTimeout = duration.of('1m')

/** How long past both deadlines a shutdown may run before the process exits anyway. */
const cutOffGrace = duration.of('5s')

/** The exit code after a third Ctrl+C: 128 plus SIGINT's number, as shells report it. */
const interruptedExitCode = 130

/** How to shut down, and what to talk to. */
export interface HandleShutdownOptions {
	/** Shuts everything down within the deadlines it gets. */
	readonly shutdown: (deadlines: CloseDeadlines) => Promise<void>
	/** How long pausing may take. Default 30 seconds. */
	readonly pauseTimeout?: Duration
	/** How long closing the backend may take after that. Default a minute. */
	readonly closeTimeout?: Duration
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
	const pauseTimeout = options.pauseTimeout ?? defaultPauseTimeout
	const closeTimeout = options.closeTimeout ?? defaultCloseTimeout
	const skipPauses = new AbortController()
	let signals = 0
	let started = false

	const begin = (exitCode: number) => {
		if (started) return
		started = true
		const pausesUp = pauseTimeout.toAbortSignal()
		const backend = new AbortController()
		// Each deadline starts when the one before it is up, so they follow each other.
		void (async () => {
			await aborted(pausesUp)
			await aborted(closeTimeout.toAbortSignal())
			backend.abort(new DOMException('The backend took too long to close.', 'TimeoutError'))
			await aborted(cutOffGrace.toAbortSignal())
			target.exit(exitCode || 1)
		})()
		const deadlines: CloseDeadlines = {
			pause: AbortSignal.any([skipPauses.signal, pausesUp]),
			backend: backend.signal,
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

/** Settles once `abortSignal` aborts, without keeping the process alive itself. */
function aborted(abortSignal: AbortSignal): Promise<void> {
	if (abortSignal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		abortSignal.addEventListener(
			'abort',
			() => {
				resolve()
			},
			{ once: true },
		)
	})
}
