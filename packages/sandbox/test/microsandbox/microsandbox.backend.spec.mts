import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SandboxSpec } from '../../src/sandbox-spec.mts'

interface FakeVm {
	readonly name: string
	readonly kill: () => Promise<void>
}

const sdk = vi.hoisted(() => {
	const state = { resolveCreate: (_vm: FakeVm) => undefined as unknown }
	const builder = {
		image: () => builder,
		cpus: () => builder,
		memory: () => builder,
		envs: () => builder,
		network: () => builder,
		interceptTls: () => builder,
		create: () =>
			new Promise<FakeVm>((resolve) => {
				state.resolveCreate = resolve
			}),
	}
	return {
		state,
		remove: vi.fn((_name: string) => Promise.resolve()),
		Sandbox: { builder: () => builder },
	}
})

vi.mock('microsandbox', () => ({
	Sandbox: { builder: sdk.Sandbox.builder, remove: sdk.remove },
	Snapshot: { list: () => Promise.resolve([]) },
	NetworkPolicy: { none: () => ({}) },
	Destination: { domain: (host: string) => host },
	Rule: { allowDns: () => ({}), allowEgress: () => ({}) },
}))

const { microsandboxBackend } = await import('../../src/microsandbox/microsandbox.backend.mts')

const spec: SandboxSpec = { image: 'node:26-slim', cpus: 1, memoryMb: 512, egress: { allow: [] } }

describe('microsandbox backend, on a fake SDK', () => {
	beforeEach(() => {
		sdk.remove.mockClear()
	})

	test('close waits for a create the SDK finishes late, and removes the VM it made', async () => {
		// Arrange
		const backend = microsandboxBackend()
		const creating = backend.create(spec, new AbortController().signal)
		creating.catch(() => undefined)
		const vm: FakeVm = { name: 'mesh-flow-0123456789ab', kill: vi.fn(() => Promise.resolve()) }

		// Act
		let closed = false
		const closing = backend.close(AbortSignal.timeout(5000)).then(() => {
			closed = true
		})
		// A macrotask, so a close that doesn't wait would have finished by now.
		await new Promise((resolve) => setTimeout(resolve, 20))
		const closedBeforeTheVmCame = closed
		sdk.state.resolveCreate(vm)
		await closing

		// Assert
		await expect(creating).rejects.toThrow('closed')
		expect(closedBeforeTheVmCame).toBe(false)
		expect(vm.kill).toHaveBeenCalledOnce()
		expect(sdk.remove).toHaveBeenCalledWith(vm.name)
	})

	test('a create after close is refused before the SDK makes a VM', async () => {
		// Arrange
		const backend = microsandboxBackend()
		await backend.close(AbortSignal.timeout(1000))
		const builder = vi.spyOn(sdk.Sandbox, 'builder')

		// Act
		const creating = backend.create(spec, AbortSignal.timeout(1000))

		// Assert
		await expect(creating).rejects.toThrow('closed')
		expect(builder).not.toHaveBeenCalled()
	})

	test('close settles when the SDK never finishes a create, once its signal aborts', async () => {
		// Arrange
		const backend = microsandboxBackend()
		const creating = backend.create(spec, new AbortController().signal)
		creating.catch(() => undefined)

		// Act
		const closing = backend.close(AbortSignal.timeout(100))

		// Assert
		await expect(closing).resolves.toBeUndefined()
		await expect(creating).rejects.toThrow('closed')
	})
})
