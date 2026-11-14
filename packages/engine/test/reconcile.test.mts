import type { BackendName, HeldSandbox, SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, test, vi } from 'vitest'
import { reconcile } from '../src/engine/reconcile.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'

const signal = new AbortController().signal

const unused = () => Promise.reject(new Error('Reconciling never creates or resumes.'))

function backendHolding(held: HeldSandbox[]) {
	const remove = vi.fn((_id: string) => Promise.resolve())
	const backend: SandboxBackend = {
		name: 'gvisor',
		create: unused,
		resume: unused,
		list: () => Promise.resolve(held),
		remove,
		close: () => Promise.resolve(),
	}
	return { backend, remove }
}

function run(id: string, status: RunStatus, sandbox?: string, backend: BackendName = 'gvisor'): RunRecord {
	const spec = { image: 'node:26-slim', cpus: 1, memoryMb: 512, egress: { allow: [] } }
	return {
		id,
		workflow: 'develop',
		trigger: { kind: 'user', id: 'develop' },
		app: { name: 'team', version: '0123456789ab', entry: 'main.mjs', sandbox: spec, tools: [] },
		status,
		cursor: 0,
		pending: [],
		createdAt: '2026-11-07T12:00:00.000Z',
		updatedAt: '2026-11-07T12:00:00.000Z',
		...(sandbox ? { sandbox: { backend, id: sandbox } } : {}),
		...(sandbox && status === 'paused' ? { paused: { backend, id: sandbox, spec } } : {}),
	}
}

describe('reconcile', () => {
	test('removes sandboxes no run owns', async () => {
		// Arrange
		const { backend, remove } = backendHolding([{ id: 'stray', state: 'running' }])

		// Act
		const { removed } = await reconcile([], backend, signal)

		// Assert
		expect(removed).toEqual(['stray'])
		expect(remove).toHaveBeenCalledWith('stray', signal)
	})

	test('reports a sandbox it cannot remove and carries on with the rest', async () => {
		// Arrange
		const { backend, remove } = backendHolding([
			{ id: 'stuck', state: 'running' },
			{ id: 'stray', state: 'running' },
		])
		remove.mockImplementationOnce(() => Promise.reject(new Error('device busy')))

		// Act
		const { removed, problems } = await reconcile([], backend, signal)

		// Assert
		expect(removed).toEqual(['stray'])
		expect(problems).toEqual(['Removing sandbox stuck failed: device busy'])
	})

	test('keeps a paused run whose paused sandbox is still there', async () => {
		// Arrange
		const { backend, remove } = backendHolding([{ id: 'kept', state: 'paused' }])

		// Act
		const { changes } = await reconcile([run('run-00000000000a', 'paused', 'kept')], backend, signal)

		// Assert
		expect(remove).not.toHaveBeenCalled()
		expect(changes.size).toBe(0)
	})

	test('removes a sandbox that still runs, because nobody can pick it up, and makes its run restartable', async () => {
		// Arrange
		const { backend } = backendHolding([{ id: 'orphan', state: 'running' }])

		// Act
		const { removed, changes } = await reconcile([run('run-00000000000a', 'running', 'orphan')], backend, signal)

		// Assert
		expect(removed).toEqual(['orphan'])
		expect(changes.get('run-00000000000a')).toMatchObject({ status: 'restartable', sandbox: undefined, pending: [] })
	})

	test('makes runs restartable whose sandbox is gone, or that never got one', async () => {
		// Arrange
		const { backend } = backendHolding([])
		const records = [run('run-00000000000a', 'paused', 'gone'), run('run-00000000000b', 'starting')]

		// Act
		const { changes } = await reconcile(records, backend, signal)

		// Assert
		expect(changes.get('run-00000000000a')?.error).toBe('Its paused sandbox is gone.')
		expect(changes.get('run-00000000000b')?.error).toBe('The engine stopped while the run was starting.')
	})

	test('leaves finished runs and runs on another backend alone', async () => {
		// Arrange
		const { backend } = backendHolding([])
		const records = [run('run-00000000000a', 'succeeded'), run('run-00000000000b', 'paused', 'elsewhere', 'e2b')]

		// Act
		const { changes } = await reconcile(records, backend, signal)

		// Assert
		expect(changes.size).toBe(0)
	})
})
