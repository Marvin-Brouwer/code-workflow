import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { Engine } from '../src/engine/engine.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { openRunStore, runDirectory, type RunStore } from '../src/runs/run-store.mts'
import { hostBackend, hostSandboxLayout, isAlive, pidsOf } from './support/host-backend.mts'
import { deferred } from './support/deferred.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runtimeScript, workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal
const deadlines = () => ({ pause: AbortSignal.timeout(5_000), backend: AbortSignal.timeout(10_000) })

interface OpenEngineOptions {
	/** An engine home to open again. Default: a new one. */
	readonly home?: string
	/** Changes what the backend does. */
	readonly wrap?: (backend: SandboxBackend) => SandboxBackend
	/** Changes what the store does. */
	readonly wrapStore?: (store: RunStore) => RunStore
}

/** An engine on the host backend, closed when the test ends. */
async function openEngine({ home, wrap = (backend) => backend, wrapStore = (store) => store }: OpenEngineOptions = {}) {
	const directory = home ?? (await temporaryDirectory())
	const host = hostBackend(path.join(directory, 'sandboxes'))
	const backend = { ...wrap(host), root: host.root }
	const store = wrapStore(openRunStore(path.join(directory, 'runs')))
	const log = vi.fn<(message: string) => void>()
	const engine = await Engine.open({ backend, store, layout: hostSandboxLayout, log }, signal)
	onTestFinished(() => engine.close(deadlines()))
	return { engine, backend, store, log, home: directory }
}

async function untilStatus(engine: Engine, id: string, status: RunStatus): Promise<RunRecord> {
	return vi.waitFor(
		() => {
			const record = engine.get(id)
			if (record.status !== status) throw new Error(`Run is ${record.status}${record.error ? `: ${record.error}` : ''}`)
			return record
		},
		{ timeout: 20_000, interval: 50 },
	)
}

async function untilPending(engine: Engine, id: string, requestId: string): Promise<void> {
	await vi.waitFor(
		() => {
			if (!engine.get(id).pending.some((request) => request.id === requestId)) throw new Error(`Not waiting for ${requestId} yet`)
		},
		{ timeout: 20_000, interval: 50 },
	)
}

const askAndEcho = runtimeScript(`
mailbox.send({ type: 'request', request: { kind: 'input', id: 'story', question: 'Which story?', fields: { key: { type: 'string' } } } })
const answer = await mailbox.answer('story', signal)
event('answered', 'input-answered', { value: answer.value })
mailbox.send({ type: 'succeeded' })
`)

describe.skipIf(process.platform !== 'linux')('Engine', () => {
	test('runs a workflow to the end, keeps its events and removes its sandbox', async () => {
		// Arrange
		const directory = await workflowRepository({
			hello: runtimeScript(
				`event('root', 'workflow-started')\nevent('child', 'log', { parentId: 'root' })\nmailbox.send({ type: 'succeeded' })`,
			),
		})
		const { engine, backend } = await openEngine()

		// Act
		const started = await engine.startRun({ directory, workflow: 'hello', abortSignal: signal })
		const finished = await untilStatus(engine, started.id, 'succeeded')

		// Assert
		expect(finished.source.dirty).toBe(false)
		expect((await engine.events(started.id)).map((event) => event.type)).toEqual(['workflow-started', 'log'])
		expect(finished.sandbox).toBeUndefined()
		// The sandbox goes after the outcome is saved.
		await vi.waitFor(async () => {
			expect(await backend.list(signal)).toEqual([])
		})
	})

	test('starts one run for a key, also when it is asked twice at once', async () => {
		// Arrange
		const directory = await workflowRepository({ hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) })
		const { engine } = await openEngine()
		const options = { directory, workflow: 'hello', key: 'webhook team/hello/1', abortSignal: signal }

		// Act
		const [first, second] = await Promise.all([engine.startRun(options), engine.startRun(options)])
		const later = await engine.startRun(options)

		// Assert
		expect(second.id).toBe(first.id)
		expect(later.id).toBe(first.id)
		expect(engine.list()).toHaveLength(1)
	})

	test('gives the entry file the workflow and its parameters, also on a restart', async () => {
		// Arrange
		const directory = await workflowRepository({
			main: runtimeScript(`const start = await mailbox.readStart(signal)\nmailbox.send({ type: 'failed', error: JSON.stringify(start) })`),
		})
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'greet', input: { name: 'Ada' }, abortSignal: signal })
		const first = await untilStatus(engine, id, 'failed')

		// Act
		await engine.restart(id, signal)
		await vi.waitFor(() => {
			expect(engine.get(id).status).not.toBe('starting')
		})
		const second = await untilStatus(engine, id, 'failed')

		// Assert
		expect(JSON.parse(first.error ?? '')).toEqual({ mode: 'run', workflow: 'greet', input: { name: 'Ada' } })
		expect(second.error).toBe(first.error)
	})

	test('relays an input request and its answer', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')

		// Act
		await engine.answer(id, 'story', { key: 'ABC-1' }, signal)
		await untilStatus(engine, id, 'succeeded')

		// Assert
		const events = await engine.events(id)
		expect(events).toEqual([expect.objectContaining({ type: 'input-answered', value: { key: 'ABC-1' } })])
	})

	test('refuses a second answer to a request while the first is on its way', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')

		// Act
		const answers = await Promise.allSettled([engine.answer(id, 'story', 'first', signal), engine.answer(id, 'story', 'second', signal)])

		// Assert
		expect(answers.map((answer) => answer.status)).toEqual(['fulfilled', 'rejected'])
		expect(answers[1]).toMatchObject({ reason: { code: 'conflict' } })
	})

	test('refuses an answer to a request the run does not wait for', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')

		// Act
		const answering = engine.answer(id, 'something-else', 1, signal)

		// Assert
		await expect(answering).rejects.toMatchObject({ code: 'not-found' })
	})

	test('answers a wake request on its own clock', async () => {
		// Arrange
		const directory = await workflowRepository({
			later: runtimeScript(`
const at = new Date(Date.now() + 300).toISOString()
mailbox.send({ type: 'request', request: { kind: 'wake', id: 'later', at } })
await mailbox.answer('later', signal)
event('woke', 'woke', { early: Date.now() < Date.parse(at) })
mailbox.send({ type: 'succeeded' })
`),
		})
		const { engine } = await openEngine()

		// Act
		const { id } = await engine.startRun({ directory, workflow: 'later', abortSignal: signal })
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(await engine.events(id)).toEqual([expect.objectContaining({ type: 'woke', early: false })])
	})

	test('keeps how a run ended when removing its sandbox fails', async () => {
		// Arrange
		const directory = await workflowRepository({ hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) })
		const { engine, log } = await openEngine({
			wrap: (backend) => ({ ...backend, remove: () => Promise.reject(new Error('device busy')) }),
		})

		// Act
		const { id } = await engine.startRun({ directory, workflow: 'hello', abortSignal: signal })
		const finished = await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(finished.sandbox).toBeUndefined()
		await vi.waitFor(() => {
			expect(log).toHaveBeenCalledWith(expect.stringContaining('device busy'))
		})
	})

	test('does not let a wake of a failed attempt answer the restarted one', async () => {
		// Arrange
		const marker = path.join(await temporaryDirectory(), 'attempted')
		const directory = await workflowRepository({
			later: runtimeScript(`
const { existsSync, writeFileSync } = await import('node:fs')
const restarted = existsSync(${JSON.stringify(marker)})
writeFileSync(${JSON.stringify(marker)}, '')
const at = new Date(Date.now() + (restarted ? 3_000 : 1_000)).toISOString()
mailbox.send({ type: 'request', request: { kind: 'wake', id: 'later', at } })
if (!restarted) {
	await new Promise((resolve) => setTimeout(resolve, 300))
	mailbox.send({ type: 'failed', error: 'A parallel branch threw.' })
} else {
	await mailbox.answer('later', signal)
	event('woke', 'woke', { early: Date.now() < Date.parse(at) })
	mailbox.send({ type: 'succeeded' })
}
`),
		})
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'later', abortSignal: signal })
		await untilStatus(engine, id, 'failed')

		// Act
		await engine.restart(id, signal)
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect(await engine.events(id)).toEqual([
			expect.objectContaining({ type: 'run-restarted' }),
			expect.objectContaining({ type: 'woke', early: false }),
		])
	})

	test('fails a run whose runtime reports a failure', async () => {
		// Arrange
		const directory = await workflowRepository({
			broken: runtimeScript(`mailbox.send({ type: 'failed', error: 'The plan was rejected.' })`),
		})
		const { engine, backend } = await openEngine()

		// Act
		const { id } = await engine.startRun({ directory, workflow: 'broken', abortSignal: signal })
		const failed = await untilStatus(engine, id, 'failed')

		// Assert
		expect(failed.error).toBe('The plan was rejected.')
		// The sandbox goes after the outcome is saved.
		await vi.waitFor(async () => {
			expect(await backend.list(signal)).toEqual([])
		})
	})

	test('fails a run whose runtime exits without an outcome, with the end of its log', async () => {
		// Arrange
		const directory = await workflowRepository({ crash: runtimeScript(`console.error('out of cheese')\nprocess.exit(2)`) })
		const { engine } = await openEngine()

		// Act
		const { id } = await engine.startRun({ directory, workflow: 'crash', abortSignal: signal })
		const failed = await untilStatus(engine, id, 'failed')

		// Assert
		expect(failed.error).toContain('exited without saying how the run ended')
		expect(failed.error).toContain('out of cheese')
	})

	test('fails a run whose setup fails, before the runtime starts', async () => {
		// Arrange
		const directory = await workflowRepository(
			{ hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) },
			{ setup: [['sh', '-c', 'echo "no lockfile" >&2; exit 4']] },
		)
		const { engine } = await openEngine()

		// Act
		const { id } = await engine.startRun({ directory, workflow: 'hello', abortSignal: signal })
		const failed = await untilStatus(engine, id, 'failed')

		// Assert
		expect(failed.error).toContain('exit code 4')
		expect(failed.error).toContain('no lockfile')
	})

	test('removes a run directory without a record when it opens', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const orphan = runDirectory(path.join(home, 'runs'), 'run-00000000000a')
		await mkdir(orphan, { recursive: true })
		await writeFile(path.join(orphan, 'start.json'), '{}')

		// Act
		const { engine } = await openEngine({ home })

		// Assert
		expect(existsSync(orphan)).toBe(false)
		expect(engine.list()).toEqual([])
	})

	test('refuses a repository that has no entry file', async () => {
		// Arrange
		const directory = await workflowRepository({})
		await rm(path.join(directory, 'main.mts'))
		const { engine } = await openEngine()

		// Act
		const starting = engine.startRun({ directory, workflow: 'missing', abortSignal: signal })

		// Assert
		await expect(starting).rejects.toMatchObject({ code: 'invalid' })
		expect(engine.list()).toEqual([])
	})

	test('stops a run and removes its sandbox', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine, backend } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')
		const sandbox = engine.get(id).sandbox?.id ?? ''
		const [runtime = 0] = await pidsOf(backend.root, sandbox)

		// Act
		const stopped = await engine.stop(id, signal)

		// Assert
		expect(stopped).toMatchObject({ status: 'stopped', pending: [] })
		expect(await backend.list(signal)).toEqual([])
		await vi.waitFor(() => {
			expect(isAlive(runtime)).toBe(false)
		})
	})

	test('finishes stopping a run when the caller stops waiting', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine, backend } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')

		// Act
		const stopping = engine.stop(id, AbortSignal.abort(new Error('Ctrl+C')))

		// Assert
		await expect(stopping).rejects.toThrow('Ctrl+C')
		await untilStatus(engine, id, 'stopped')
		await vi.waitFor(async () => {
			expect(await backend.list(signal)).toEqual([])
		})
	})

	test('keeps a run stopped that was stopped while its restart was being saved', async () => {
		// Arrange
		const held = deferred<undefined>()
		let holding = false
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine, backend } = await openEngine({
			wrapStore: (store) => ({
				...store,
				save: async (record) => {
					if (holding && record.status === 'starting') await held.promise
					return store.save(record)
				},
			}),
		})
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')
		await engine.stop(id, signal)

		holding = true

		// Act
		const restarting = engine.restart(id, signal)
		const stopping = engine.stop(id, signal)
		held.resolve(undefined)
		await restarting
		const stopped = await stopping

		// Assert
		expect(stopped.status).toBe('stopped')
		await delay(500)
		expect(engine.get(id).status).toBe('stopped')
		expect(await backend.list(signal)).toEqual([])
	})

	test('refuses a second resume while the first is under way', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const first = await openEngine()
		const { id } = await first.engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(first.engine, id, 'story')
		await first.engine.close(deadlines())
		const second = await openEngine({ home: first.home })

		// Act
		const resumes = await Promise.allSettled([second.engine.resume(id, signal), second.engine.resume(id, signal)])

		// Assert
		expect(resumes.map((resume) => resume.status)).toEqual(['fulfilled', 'rejected'])
		expect(resumes[1]).toMatchObject({ reason: { code: 'conflict' } })
	})

	test('pauses a waiting run on close and resumes it after a restart of the engine', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const first = await openEngine()
		const { id } = await first.engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(first.engine, id, 'story')
		await first.engine.close(deadlines())
		const second = await openEngine({ home: first.home })

		// Act
		const resumed = await second.engine.resume(id, signal)
		await second.engine.answer(id, 'story', 'after the restart', signal)
		await untilStatus(second.engine, id, 'succeeded')

		// Assert
		expect(resumed.pending).toEqual([expect.objectContaining({ id: 'story' })])
		expect(await second.engine.events(id)).toEqual([expect.objectContaining({ value: 'after the restart' })])
	})

	test('restarts a stopped run from the top, with the code it first ran', async () => {
		// Arrange
		const directory = await workflowRepository({ ask: askAndEcho })
		const { engine } = await openEngine()
		const { id } = await engine.startRun({ directory, workflow: 'ask', abortSignal: signal })
		await untilPending(engine, id, 'story')
		await engine.stop(id, signal)

		// Act
		await engine.restart(id, signal)
		await untilPending(engine, id, 'story')
		await engine.answer(id, 'story', 'second try', signal)
		await untilStatus(engine, id, 'succeeded')

		// Assert
		expect((await engine.events(id)).map((event) => event.type)).toEqual(['run-restarted', 'input-answered'])
	})
})
