import { describe, expect, test, vi } from 'vitest'
import { BackendLifetime } from '../src/backend-lifetime.mts'

describe('BackendLifetime', () => {
	test('aborts the signals it handed out when it closes', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		const signal = lifetime.bind(new AbortController().signal)

		// Act
		await lifetime.close(AbortSignal.timeout(1000))

		// Assert
		expect(signal.aborted).toBe(true)
	})

	test('follows the caller signal too', () => {
		// Arrange
		const lifetime = new BackendLifetime()
		const caller = new AbortController()
		const signal = lifetime.bind(caller.signal)

		// Act
		caller.abort()

		// Assert
		expect(signal.aborted).toBe(true)
	})

	test('removes every tracked sandbox on close, but not untracked ones', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		const removeRunning = vi.fn(() => Promise.resolve())
		const removePaused = vi.fn(() => Promise.resolve())
		lifetime.track('running', removeRunning)
		lifetime.track('paused', removePaused)
		lifetime.untrack('paused')

		// Act
		await lifetime.close(AbortSignal.timeout(1000))

		// Assert
		expect(removeRunning).toHaveBeenCalledOnce()
		expect(removePaused).not.toHaveBeenCalled()
	})

	test('removes the others when one removal fails, then reports the failure', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		const removeOther = vi.fn(() => Promise.resolve())
		lifetime.track('broken', () => Promise.reject(new Error('gone wrong')))
		lifetime.track('other', removeOther)

		// Act
		const closing = lifetime.close(AbortSignal.timeout(1000))

		// Assert
		await expect(closing).rejects.toThrow(AggregateError)
		expect(removeOther).toHaveBeenCalledOnce()
	})

	test('refuses new work once closed', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		await lifetime.close(AbortSignal.timeout(1000))

		// Act
		const start = () => lifetime.bind(new AbortController().signal)

		// Assert
		expect(start).toThrow('closed')
	})

	test('waits on close for work it keeps', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		let finished = false
		void lifetime.keep(
			new Promise<void>((resolve) => {
				setTimeout(() => {
					finished = true
					resolve()
				}, 50)
			}),
		)

		// Act
		await lifetime.close(AbortSignal.timeout(1000))

		// Assert
		expect(finished).toBe(true)
	})

	test('stops waiting for kept work when the close signal aborts', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		void lifetime.keep(new Promise<void>(() => undefined))

		// Act
		const closing = lifetime.close(AbortSignal.timeout(50))

		// Assert
		await expect(closing).resolves.toBeUndefined()
	})

	test('removes a sandbox that is tracked after close, and refuses it', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		await lifetime.close(AbortSignal.timeout(1000))
		const remove = vi.fn(() => Promise.resolve())

		// Act
		const track = () => {
			lifetime.track('late', remove)
		}

		// Assert
		expect(track).toThrow('closed')
		expect(remove).toHaveBeenCalledOnce()
	})

	test('destroy removes a sandbox and forgets it', async () => {
		// Arrange
		const lifetime = new BackendLifetime()
		const remove = vi.fn(() => Promise.resolve())
		lifetime.track('running', remove)

		// Act
		await lifetime.destroy('running', AbortSignal.timeout(1000))

		// Assert
		expect(remove).toHaveBeenCalledOnce()
		expect(lifetime.tracks('running')).toBe(false)
	})
})
