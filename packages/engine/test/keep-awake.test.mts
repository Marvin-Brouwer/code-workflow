import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { keepAwake, powerRequestReason } from '../src/serve/keep-awake.mts'
import type { PowerApi } from '../src/serve/windows-power.mts'

/** A stand-in for kernel32 that records what it was asked. */
function fakePowerApi(overrides: Partial<PowerApi> = {}) {
	const release = vi.fn()
	const api: PowerApi = {
		holdPowerRequest: vi.fn(() => release),
		optOutOfThrottling: vi.fn(),
		...overrides,
	}
	return { api, release }
}

describe('keepAwake', () => {
	test('on Windows, holds a power request and stops throttling until it is given back, once', async () => {
		// Arrange
		const { api, release } = fakePowerApi()
		const log = vi.fn()

		// Act
		const releasePower = await keepAwake({
			abortSignal: new AbortController().signal,
			log,
			platform: 'win32',
			loadPowerApi: async () => api,
		})
		const releasedBeforeShutdown = release.mock.calls.length
		releasePower()
		releasePower()

		// Assert
		expect(api.holdPowerRequest).toHaveBeenCalledWith(powerRequestReason)
		expect(api.optOutOfThrottling).toHaveBeenCalledOnce()
		expect(releasedBeforeShutdown).toBe(0)
		expect(release).toHaveBeenCalledOnce()
		expect(log).not.toHaveBeenCalled()
	})

	test('settles promptly when the engine shuts down while the power calls never load', async () => {
		// Arrange
		const lifetime = new AbortController()
		const started = performance.now()

		// Act
		const kept = keepAwake({
			abortSignal: lifetime.signal,
			log: vi.fn(),
			platform: 'win32',
			loadPowerApi: () => new Promise(() => undefined),
		})
		setTimeout(() => {
			lifetime.abort(new Error('The engine is shutting down.'))
		}, 10)
		const releasePower = await kept

		// Assert
		expect(releasePower).toBeTypeOf('function')
		expect(performance.now() - started).toBeLessThan(1000)
	})

	test('does nothing on Linux or macOS', async () => {
		// Arrange
		const loadPowerApi = vi.fn(async () => fakePowerApi().api)

		// Act
		await keepAwake({ abortSignal: new AbortController().signal, log: vi.fn(), platform: 'linux', loadPowerApi })
		await keepAwake({ abortSignal: new AbortController().signal, log: vi.fn(), platform: 'darwin', loadPowerApi })

		// Assert
		expect(loadPowerApi).not.toHaveBeenCalled()
	})

	test('warns and lets the engine start when Windows says no', async () => {
		// Arrange
		const { api } = fakePowerApi({
			holdPowerRequest: () => {
				throw new Error('PowerCreateRequest failed with Windows error 5.')
			},
			optOutOfThrottling: () => {
				throw new Error('SetProcessInformation failed with Windows error 87.')
			},
		})
		const log = vi.fn()

		// Act
		const kept = keepAwake({ abortSignal: new AbortController().signal, log, platform: 'win32', loadPowerApi: async () => api })
		const unloadable = keepAwake({
			abortSignal: new AbortController().signal,
			log,
			platform: 'win32',
			loadPowerApi: () => Promise.reject(new Error('koffi has no build for this machine')),
		})

		// Assert
		await expect(kept).resolves.toBeTypeOf('function')
		await expect(unloadable).resolves.toBeTypeOf('function')
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
		const releasePower = await keepAwake({ abortSignal: lifetime.signal, log: vi.fn(), platform: 'win32', loadPowerApi: async () => api })
		releasePower()

		// Assert
		expect(api.holdPowerRequest).not.toHaveBeenCalled()
	})

	test.runIf(process.platform === 'win32')('takes and gives back a real power request on Windows', async () => {
		// Arrange
		const { windowsPowerApi } = await import('../src/serve/windows-power.mts')
		const api = windowsPowerApi()

		// Act
		const release = api.holdPowerRequest(powerRequestReason)
		onTestFinished(release)
		api.optOutOfThrottling()

		// Assert
		expect(release).not.toThrow()
	})
})
