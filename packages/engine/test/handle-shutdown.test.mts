import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import type { CloseOptions } from '../src/engine/engine.mts'
import { handleShutdown, type ShutdownProcess } from '../src/shutdown/handle-shutdown.mts'

function fakeProcess() {
	const events = new EventEmitter()
	const exit = vi.fn<(code: number) => void>()
	const target: ShutdownProcess = {
		on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
		exit,
	}
	return { events, exit, target }
}

describe('handleShutdown', () => {
	test('shuts down on the first signal and exits with 0', async () => {
		// Arrange
		const { events, exit, target } = fakeProcess()
		const shutdown = vi.fn((_deadlines: CloseOptions) => Promise.resolve())
		handleShutdown({ shutdown, process: target, log: vi.fn() })

		// Act
		events.emit('SIGINT')

		// Assert
		await vi.waitFor(() => {
			expect(exit).toHaveBeenCalledWith(0)
		})
		expect(shutdown).toHaveBeenCalledOnce()
	})

	test('skips the pauses on a second signal, but still closes', () => {
		// Arrange
		const { events, target } = fakeProcess()
		let deadlines: CloseOptions | undefined
		handleShutdown({
			shutdown: (given) => {
				deadlines = given
				return new Promise(() => undefined)
			},
			process: target,
			log: vi.fn(),
		})

		// Act
		events.emit('SIGTERM')
		events.emit('SIGINT')

		// Assert
		expect(deadlines?.pause.aborted).toBe(true)
		expect(deadlines?.close.aborted).toBe(false)
	})

	test('exits right away on a third signal', () => {
		// Arrange
		const { events, exit, target } = fakeProcess()
		handleShutdown({ shutdown: () => new Promise(() => undefined), process: target, log: vi.fn() })

		// Act
		events.emit('SIGINT')
		events.emit('SIGINT')
		events.emit('SIGINT')

		// Assert
		expect(exit).toHaveBeenCalledWith(130)
	})

	test('shuts down and exits with 1 after an error nothing caught', async () => {
		// Arrange
		const { events, exit, target } = fakeProcess()
		const shutdown = vi.fn(() => Promise.resolve())
		handleShutdown({ shutdown, process: target, log: vi.fn() })

		// Act
		events.emit('unhandledRejection', new Error('nobody caught this'))

		// Assert
		await vi.waitFor(() => {
			expect(exit).toHaveBeenCalledWith(1)
		})
		expect(shutdown).toHaveBeenCalledOnce()
	})

	test('cuts off a shutdown that never settles', () => {
		// Arrange
		vi.useFakeTimers()
		const { events, exit, target } = fakeProcess()
		handleShutdown({
			shutdown: () => new Promise(() => undefined),
			process: target,
			log: vi.fn(),
			pauseTimeoutMs: 100,
			closeTimeoutMs: 100,
		})

		// Act
		events.emit('SIGINT')
		vi.advanceTimersByTime(10_000)

		// Assert
		expect(exit).toHaveBeenCalledWith(1)
		vi.useRealTimers()
	})
})
