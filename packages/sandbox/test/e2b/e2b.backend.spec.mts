import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SandboxSpec } from '../../src/sandbox-spec.mts'

const sdk = vi.hoisted(() => {
	const kill = vi.fn((_options: { signal: AbortSignal }) => Promise.resolve())
	const create = vi.fn(
		(_template: string, options: { signal: AbortSignal }) =>
			new Promise((resolve, reject) => {
				if (options.signal.aborted) reject(new Error('aborted'))
				options.signal.addEventListener('abort', () => {
					reject(new Error('aborted'))
				})
				resolve({ sandboxId: 'e2b-sandbox-1', kill })
			}),
	)
	return { kill, create }
})

vi.mock('e2b', () => ({
	ALL_TRAFFIC: '0.0.0.0/0',
	CommandExitError: class CommandExitError extends Error {},
	Sandbox: { create: sdk.create },
}))

const { e2bBackend } = await import('../../src/e2b/e2b.backend.mts')

const spec: SandboxSpec = { image: 'node:26-slim', cpus: 1, memoryMb: 512, egress: { allow: [] } }

describe('E2B backend, on a fake SDK', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	test('close kills the sandboxes it still runs', async () => {
		// Arrange
		const backend = e2bBackend({ apiKey: 'e2b_test', templates: { 'node:26-slim': 'node-22' } })
		await backend.create(spec, AbortSignal.timeout(1000))

		// Act
		await backend.close(AbortSignal.timeout(1000))

		// Assert
		expect(sdk.kill).toHaveBeenCalledOnce()
	})

	test('refuses an image without a template, before calling E2B', async () => {
		// Arrange
		const backend = e2bBackend({ apiKey: 'e2b_test', templates: {} })

		// Act
		const creating = backend.create(spec, AbortSignal.timeout(1000))

		// Assert
		await expect(creating).rejects.toThrow("No E2B template is configured for the image 'node:26-slim'.")
		expect(sdk.create).not.toHaveBeenCalled()
	})
})
