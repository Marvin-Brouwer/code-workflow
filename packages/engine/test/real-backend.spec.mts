import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { Engine } from '../src/engine/engine.mts'
import { openRunStore } from '../src/runs/run-store.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { copiedMailbox, runtimeScript, workflowRepository } from './support/workflow-repository.mts'

/**
 * One run end to end in a real sandbox, across a shutdown and a restart of the engine. Opt in, as
 * the sandbox package's conformance suite: `MESH_FLOW_ENGINE_TESTS=gvisor` (with
 * `RUNSC="sudo $(command -v runsc)"` when not root) or `MESH_FLOW_ENGINE_TESTS=microsandbox`.
 */
const backendName = process.env.MESH_FLOW_ENGINE_TESTS
const signal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(60_000), backend: AbortSignal.timeout(60_000) })

/** Loads only the backend under test, so the other's SDK isn't needed. */
async function openBackend(): Promise<SandboxBackend> {
	if (backendName === 'microsandbox') return (await import('@mesh-flow/sandbox/microsandbox')).microsandboxBackend()
	const { gvisorBackend } = await import('@mesh-flow/sandbox/gvisor')
	return gvisorBackend({
		directory: process.env.MESH_FLOW_GVISOR_DIRECTORY ?? path.join(tmpdir(), 'mesh-flow-gvisor-engine'),
		runsc: (process.env.RUNSC ?? 'runsc').split(' ').filter(Boolean),
	})
}

const twoQuestions = runtimeScript(
	`
for (const id of ['first', 'second']) {
	mailbox.send({ type: 'request', request: { kind: 'input', id, question: id, fields: {} } })
	const { value } = await mailbox.answer(id, signal)
	event(id, 'answered', { value, pid: process.pid })
}
mailbox.send({ type: 'succeeded' })
`,
	copiedMailbox,
)

describe.runIf(backendName)(`the engine on ${backendName ?? 'a real backend'}`, () => {
	test('runs a workflow across a shutdown and a restart of the engine, in the same process', { timeout: 300_000 }, async () => {
		// Arrange
		const home = await temporaryDirectory()
		const store = () => openRunStore(path.join(home, 'runs'))
		const directory = await workflowRepository({ ask: twoQuestions }, { image: 'node:22-slim', copyMailbox: true })
		const first = await Engine.open({ backend: await openBackend(), store: store() }, signal)
		onTestFinished(() => first.close(deadlines()))
		const { id } = await first.startRun({ directory, workflow: 'ask', signal })
		await vi.waitFor(
			() => {
				expect(first.get(id).pending).toHaveLength(1)
			},
			{ timeout: 240_000, interval: 500 },
		)
		await first.answer(id, 'first', 1, signal)
		await vi.waitFor(
			() => {
				expect(first.get(id).pending).toEqual([expect.objectContaining({ id: 'second' })])
			},
			{ timeout: 60_000, interval: 500 },
		)
		await first.close(deadlines())

		// Act
		const backend = await openBackend()
		const second = await Engine.open({ backend, store: store() }, signal)
		onTestFinished(() => second.close(deadlines()))
		await second.resume(id, signal)
		await second.answer(id, 'second', 2, signal)
		await vi.waitFor(
			() => {
				expect(second.get(id).status).toBe('succeeded')
			},
			{ timeout: 60_000, interval: 500 },
		)

		// Assert
		const events = await second.events(id)
		expect(events.map((event) => event['value'])).toEqual([1, 2])
		expect(events[0]?.['pid']).toBe(events[1]?.['pid'])
		// The sandbox goes after the outcome is saved.
		await vi.waitFor(async () => {
			expect(await backend.list(signal)).toEqual([])
		}, 60_000)
	})
})
