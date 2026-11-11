import { describe, expect, test, vi } from 'vitest'
import { keepAwake, powerRequestReason } from '../src/serve/keep-awake.mts'
import type { PowerApi } from '../src/serve/windows-power.mts'

/** A stand-in for kernel32 that records what it was asked. */
function fakePowerApi(overrides: Partial<PowerApi> = {}) {
	const release = vi.fn()
	const api: PowerApi = {
		requestPower: vi.fn(() => release),
		stopThrottling: vi.fn(),
		...overrides,
	}
	return { api, release }
}

describe('keepAwake', () => {
	test('on Windows, holds a power request and stops throttling until the engine shuts down', async () => {
		// Arrange
		const { api, release } = fakePowerApi()
		const lifetime = new AbortController()
		const log = vi.fn()

		// Act
		await keepAwake({ abortSignal: lifetime.signal, log, platform: 'win32', powerApi: async () => api })
		const releasedBeforeShutdown = release.mock.calls.length
		lifetime.abort(new Error('The engine is shutting down.'))

		// Assert
		expect(api.requestPower).toHaveBeenCalledWith(powerRequestReason)
		expect(api.stopThrottling).toHaveBeenCalledOnce()
		expect(releasedBeforeShutdown).toBe(0)
		expect(release).toHaveBeenCalledOnce()
		expect(log).not.toHaveBeenCalled()
	})

	test('does nothing on Linux or macOS', async () => {
		// Arrange
		const powerApi = vi.fn(async () => fakePowerApi().api)

		// Act
		await keepAwake({ abortSignal: new AbortController().signal, log: vi.fn(), platform: 'linux', powerApi })
		await keepAwake({ abortSignal: new AbortController().signal, log: vi.fn(), platform: 'darwin', powerApi })

		// Assert
		expect(powerApi).not.toHaveBeenCalled()
	})

	test('warns and lets the engine start when Windows says no', async () => {
		// Arrange
		const { api } = fakePowerApi({
			requestPower: () => {
				throw new Error('PowerCreateRequest failed with Windows error 5.')
			},
			stopThrottling: () => {
				throw new Error('SetProcessInformation failed with Windows error 87.')
			},
		})
		const log = vi.fn()

		// Act
		const kept = keepAwake({ abortSignal: new AbortController().signal, log, platform: 'win32', powerApi: async () => api })
		const unloadable = keepAwake({
			abortSignal: new AbortController().signal,
			log,
			platform: 'win32',
			powerApi: () => Promise.reject(new Error('koffi has no build for this machine')),
		})

		// Assert
		await expect(kept).resolves.toBeUndefined()
		await expect(unloadable).resolves.toBeUndefined()
		expect(log.mock.calls.map(([message]) => String(message))).toEqual([
			expect.stringContaining('Windows error 5'),
			expect.stringContaining('Windows error 87'),
			expect.stringContaining('koffi has no build for this machine'),
		])
	})

	test('takes nothing when the engine is already shutting down', async () => {
		// Arrange
		const { api } = fakePowerApi()
		const lifetime = new AbortController()
		lifetime.abort(new Error('The engine is shutting down.'))

		// Act
		await keepAwake({ abortSignal: lifetime.signal, log: vi.fn(), platform: 'win32', powerApi: async () => api })

		// Assert
		expect(api.requestPower).not.toHaveBeenCalled()
	})

	test.runIf(process.platform === 'win32')('takes and gives back a real power request on Windows', async () => {
		// Arrange
		const { windowsPowerApi } = await import('../src/serve/windows-power.mts')
		const api = windowsPowerApi()

		// Act
		const release = api.requestPower(powerRequestReason)
		api.stopThrottling()
		release()

		// Assert
		expect(release).toBeTypeOf('function')
	})
})
