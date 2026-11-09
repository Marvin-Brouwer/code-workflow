import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	runIdEnvironmentVariable,
	type Answer,
	type RunStart,
	type RuntimeEvent,
	type RuntimeMessage,
	type RuntimeRequest,
	type WakeRequest,
	type WorkflowsDescription,
} from '@mesh-flow/protocol'
import { abortable, type PausedSandbox, type Sandbox, type SandboxBackend } from '@mesh-flow/sandbox'
import { messageOf } from '../errors.mts'
import { SandboxChannel } from '../mailbox/sandbox-channel.mts'
import { applyRunChange, type RunChange } from '../runs/run-change.mts'
import { newRunId, RunId } from '../runs/run-id.mts'
import { finishedStatuses, type RunRecord, type RunStatus, type RunTrigger } from '../runs/run-record.mts'
import type { RunStore } from '../runs/run-store.mts'
import { describeInSandbox } from '../triggers/describe-in-sandbox.mts'
import { memoryDescriptionCache, type DescriptionCache } from '../triggers/description-cache.mts'
import { entryFile, findEntry } from '../workflow/workflow-config.mts'
import { packWorkflowSource, sourceKey } from '../workflow/workflow-source.mts'
import { EngineError } from './engine-error.mts'
import { reconcile } from './reconcile.mts'
import { defaultSandboxLayout, type SandboxLayout } from './sandbox-layout.mts'
import { setUpRuntime } from './set-up-runtime.mts'
import { settleWithin } from './settle-within.mts'
import { wakeAt } from './wake-at.mts'

/** What an engine runs on. */
export interface EngineOptions {
	/** Where the runs' sandboxes are made. */
	readonly backend: SandboxBackend
	/** Where the run records are kept. */
	readonly store: RunStore
	/** Where things go inside a sandbox. */
	readonly layout?: SandboxLayout
	/** Where the engine reports what it did on its own, such as reconciling. Default: nowhere. */
	readonly log?: (message: string) => void
	/** The engine's clock, for wakes and timestamps. Default: the system clock. */
	readonly now?: () => Date
	/** Where descriptions of entry files are kept, by source key. Default: in memory. */
	readonly descriptions?: DescriptionCache
}

/** Which workflow to start a run of, and with what. */
export interface StartRunOptions {
	/** The workflow repository on the host, with its `mesh-flow.config.json` and entry file. */
	readonly directory: string
	/** The workflow's name, as `workflow()` names it. The entry file's modules have to define it. */
	readonly workflow: string
	/**
	 * The run's parameters, which the runtime checks against the workflow's; for a webhook
	 * trigger, the delivery's payload, which the trigger's schema turns into them. Default `{}`.
	 */
	readonly input?: unknown
	/** The trigger that starts the run, when one does. */
	readonly trigger?: RunTrigger
	/** Names what the run is for, such as a webhook delivery. A run with this key already is returned instead. */
	readonly key?: string
	readonly signal: AbortSignal
}

/** How long each step of a shutdown may take. */
export interface CloseDeadlines {
	/** Bounds pausing the running sandboxes. Abort it to skip the pauses, as on a second Ctrl+C. */
	readonly pause: AbortSignal
	/** Bounds closing the backend, which removes every sandbox that isn't paused. */
	readonly backend: AbortSignal
}

/** A run the engine is driving in this process. */
interface ActiveRun {
	readonly controller: AbortController
	sandbox?: Sandbox
	channel?: SandboxChannel
	work: Promise<void>
}

/** Which sandbox a run record points at. */
type SandboxRef = NonNullable<RunRecord['sandbox']>

/** How long cleaning up after a run, such as removing its sandbox, may take. */
const cleanupTimeoutMs = 60_000

/** How long describing an entry file may take, setup steps such as `npm ci` included. */
const describeTimeoutMs = 10 * 60_000

/**
 * The host process's view of runs: it starts each run in its own sandbox, relays requests and
 * answers through the sandbox's mailbox, pauses everything on shutdown and reconciles on start.
 * It never runs workflow code itself.
 *
 * @example
 * ```ts
 * const engine = await Engine.open({ backend, store: openRunStore(directory) }, signal)
 * const run = await engine.startRun({ directory: process.cwd(), workflow: 'develop', signal })
 * // ... later, on Ctrl+C:
 * await engine.close({ pause: AbortSignal.timeout(30_000), backend: AbortSignal.timeout(60_000) })
 * ```
 */
export class Engine {
	readonly #backend: SandboxBackend
	readonly #store: RunStore
	readonly #layout: SandboxLayout
	readonly #log: (message: string) => void
	readonly #now: () => Date
	readonly #records = new Map<RunId, RunRecord>()
	readonly #active = new Map<RunId, ActiveRun>()
	readonly #lifetime = new AbortController()
	/** Input requests an answer is on its way to, as `<run>/<request>`, so a second answer is refused. */
	readonly #answering = new Set<string>()
	/** Runs with a key that are being started, so a second start with the key waits for the first. */
	readonly #keyed = new Map<string, Promise<RunRecord>>()
	readonly #descriptions: DescriptionCache
	/** Describes going on, by source key, so callers who ask at once share one sandbox. */
	readonly #describing = new Map<string, Promise<WorkflowsDescription>>()
	#closing: Promise<void> | undefined

	private constructor(options: EngineOptions) {
		this.#backend = options.backend
		this.#store = options.store
		this.#layout = options.layout ?? defaultSandboxLayout
		this.#log = options.log ?? (() => undefined)
		this.#now = options.now ?? (() => new Date())
		this.#descriptions = options.descriptions ?? memoryDescriptionCache()
	}

	/** Loads the run records and reconciles them with the backend. Resumes nothing. */
	static async open(options: EngineOptions, signal: AbortSignal): Promise<Engine> {
		const engine = new Engine(options)
		const { records, problems } = await options.store.loadAll()
		for (const problem of problems) engine.#log(problem)
		for (const record of records) engine.#records.set(record.id, record)

		const { removed, problems: leftOver, changes } = await reconcile(records, options.backend, signal)
		for (const id of removed) engine.#log(`Removed sandbox ${id}: no run can pick it up.`)
		for (const problem of leftOver) engine.#log(problem)
		for (const [id, change] of changes) {
			const record = await engine.#update(id, change)
			engine.#log(`Run ${id} is restartable: ${record.error ?? 'its sandbox is gone.'}`)
		}
		return engine
	}

	/** Every run the engine knows, also finished ones. */
	list(): RunRecord[] {
		return [...this.#records.values()]
	}

	/** One run as it is now. Throws `not-found` for an unknown id. */
	get(id: string): RunRecord {
		const record = RunId.safeParse(id).success ? this.#records.get(id) : undefined
		if (!record) throw new EngineError('not-found', `There is no run ${id}.`)
		return record
	}

	/** The run's event tree so far, in the order the runtime sent it. */
	events(id: string): Promise<RuntimeEvent[]> {
		return this.#store.events(this.get(id).id)
	}

	/** The run started with this key, if there is one. */
	runWithKey(key: string): RunRecord | undefined {
		return this.list().find((record) => record.key === key)
	}

	/**
	 * Starts a run of a workflow through the repository's entry file. Returns once the record is
	 * saved; the sandbox is made and set up in the background, so follow the run's status. With a
	 * `key`, a run that has it already is returned instead, also while it's being started.
	 */
	async startRun(options: StartRunOptions): Promise<RunRecord> {
		this.#assertOpen()
		const { key } = options
		if (key === undefined) return this.#create(options)
		// Nothing is awaited before the key is taken, so two starts with it can't both create a run.
		const known = this.runWithKey(key) ?? this.#keyed.get(key)
		if (known !== undefined) return known
		const creating = this.#create(options).finally(() => {
			this.#keyed.delete(key)
		})
		this.#keyed.set(key, creating)
		return creating
	}

	async #create(options: StartRunOptions): Promise<RunRecord> {
		const signal = this.#withLifetime(options.signal)
		const { config, file } = await findEntry(options.directory).catch((error: unknown) => {
			throw new EngineError('invalid', messageOf(error))
		})

		const id = newRunId()
		const source = await packWorkflowSource(options.directory, this.#store.sourceOf(id), signal).catch(async (error: unknown) => {
			// Best effort: the pack error is the one to report.
			await this.#store.removeRun(id).catch(() => undefined)
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
			throw new EngineError('invalid', `Packing ${options.directory} failed: ${messageOf(error)}`)
		})
		const { trigger } = options
		const start: RunStart = {
			mode: 'run',
			workflow: options.workflow,
			...(trigger === undefined ? {} : { trigger: { kind: trigger.kind, id: trigger.id } }),
			...(options.input === undefined ? {} : { input: options.input }),
		}
		await this.#store.saveStart(id, start)
		if (this.#lifetime.signal.aborted) {
			await this.#store.removeRun(id).catch(() => undefined)
			this.#assertOpen()
		}
		const createdAt = this.#now().toISOString()
		const record: RunRecord = {
			id,
			workflow: options.workflow,
			...(trigger === undefined ? {} : { trigger }),
			...(options.key === undefined ? {} : { key: options.key }),
			source,
			config,
			status: 'starting',
			cursor: 0,
			pending: [],
			createdAt,
			updatedAt: createdAt,
		}
		this.#records.set(id, record)
		const saving = this.#store.save(record)
		// Driven before anything is awaited, so a stop sees the run as taken.
		this.#drive(id, async (active, runSignal) => {
			await saving
			runSignal.throwIfAborted()
			await this.#start(id, file, active, runSignal)
		})
		await saving
		return record
	}

	/**
	 * What a repository's entry file declares: its workflows, their parameters and its triggers.
	 * The entry file runs in describe mode in a sandbox, never on the host. Descriptions are kept by
	 * source key, so the same code is described once, and callers who ask at the same time share
	 * one sandbox. Aborting `signal` stops the waiting; the describe goes on for the others.
	 */
	async describe(directory: string, signal: AbortSignal): Promise<WorkflowsDescription> {
		this.#assertOpen()
		const waitSignal = this.#withLifetime(signal)
		const { config, file } = await findEntry(directory).catch((error: unknown) => {
			throw new EngineError('invalid', messageOf(error))
		})
		const key = await sourceKey(directory, waitSignal)
		const cached = await this.#descriptions.get(key)
		if (cached !== undefined) return cached
		let describing = this.#describing.get(key)
		if (describing === undefined) {
			describing = this.#describeAt(key, directory, config, file).finally(() => {
				this.#describing.delete(key)
			})
			this.#describing.set(key, describing)
			// Every caller may have stopped waiting; a failure is theirs to see, never unhandled.
			describing.catch(() => undefined)
		}
		return abortable(describing, waitSignal)
	}

	async #describeAt(key: string, directory: string, config: RunRecord['config'], file: string): Promise<WorkflowsDescription> {
		const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(describeTimeoutMs)])
		const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-describe-'))
		try {
			const tarball = path.join(scratch, 'source.tgz')
			await packWorkflowSource(directory, tarball, signal)
			const options = { backend: this.#backend, layout: this.#layout, config, file, tarball, log: this.#log }
			const description = await describeInSandbox({ ...options, cleanupSignal: () => this.#cleanupSignal() }, signal)
			await this.#descriptions.set(key, description)
			return description
		} finally {
			await rm(scratch, { recursive: true, force: true })
		}
	}

	/** Answers an input request. The runtime validates the value against what it asked for. */
	async answer(id: string, requestId: string, value: unknown, signal: AbortSignal): Promise<RunRecord> {
		const record = this.get(id)
		const request = record.pending.find((pending) => pending.id === requestId)
		if (request?.kind !== 'input') throw new EngineError('not-found', `Run ${id} doesn't wait for input ${requestId}.`)
		if (record.status !== 'running') throw new EngineError('conflict', `Run ${id} is ${record.status}; resume it first.`)
		const key = `${record.id}/${requestId}`
		if (this.#answering.has(key)) throw new EngineError('conflict', `Input ${requestId} of run ${id} is being answered already.`)
		this.#answering.add(key)
		try {
			await this.#deliver(record.id, requestId, { value }, this.#withLifetime(signal))
		} finally {
			this.#answering.delete(key)
		}
		return this.get(id)
	}

	/**
	 * Stops a run and removes its sandbox, also a paused one. Branches and merge requests stay.
	 * Aborting `signal` stops the waiting, not the stopping.
	 */
	stop(id: string, signal: AbortSignal): Promise<RunRecord> {
		this.#assertOpen()
		const record = this.#requireStatus(id, ['starting', 'running', 'paused', 'restartable'])
		return abortable(this.#stop(record.id), this.#withLifetime(signal))
	}

	/** Resumes a paused run where it was, with every request it was waiting on. */
	async resume(id: string, signal: AbortSignal): Promise<RunRecord> {
		this.#assertOpen()
		const record = this.#requireStatus(id, ['paused'])
		const paused = record.paused
		if (!paused) throw new EngineError('conflict', `Run ${id} has no paused sandbox.`)
		if (paused.backend !== this.#backend.name) {
			throw new EngineError('conflict', `Run ${id} was paused on ${paused.backend}; this engine runs ${this.#backend.name}.`)
		}
		if (this.#active.has(record.id)) throw new EngineError('conflict', `Run ${id} is being resumed already.`)
		// Driven from the start, so a stop, a second resume or a shutdown sees the run as taken.
		return new Promise((resolve, reject) => {
			this.#drive(record.id, async (active, runSignal) => {
				const channel = await this.#reattach(record.id, paused, active, signal, runSignal).catch((error: unknown) => {
					reject(runSignal.aborted ? cutShort(id, runSignal) : error)
					// Once the sandbox runs, a failure fails the run. Before that, the run stays paused.
					if (active.sandbox) throw error
				})
				if (!channel) return
				const resumed = this.get(record.id)
				resolve(resumed)
				for (const request of resumed.pending) this.#schedule(record.id, channel, request, runSignal)
				await this.#pump(record.id, channel, runSignal)
			})
		})
	}

	/**
	 * Runs a run again from the top, in a new sandbox, with the code it first ran. Aborting `signal`
	 * only refuses a restart that hasn't begun; the restart itself runs in the background.
	 */
	async restart(id: string, signal: AbortSignal): Promise<RunRecord> {
		this.#assertOpen()
		signal.throwIfAborted()
		const record = this.#requireStatus(id, ['restartable', 'failed', 'stopped'])
		const leftOver = record.sandbox
		const file = entryFile(record.config)
		// The status changes and the drive starts before anything is awaited, so a second restart
		// is refused and a stop sees the run as taken.
		const saving = this.#update(record.id, {
			status: 'starting',
			sandbox: undefined,
			paused: undefined,
			cursor: 0,
			pending: [],
			error: undefined,
		})
		this.#drive(record.id, async (active, runSignal) => {
			await saving
			runSignal.throwIfAborted()
			if (leftOver) await this.#discard(record.id, leftOver)
			await this.#store.appendEvents(record.id, [restartEvent(this.#now())])
			await this.#start(record.id, file, active, runSignal)
		})
		return saving
	}

	/**
	 * Shuts down and leaves nothing running: stops driving every run, pauses every running
	 * sandbox to disk, flushes the records and closes the backend, which removes what wasn't
	 * paused. A run that couldn't be paused becomes restartable. Calling it again waits for the
	 * same shutdown.
	 */
	close(deadlines: CloseDeadlines): Promise<void> {
		this.#closing ??= this.#close(deadlines)
		return this.#closing
	}

	async #close({ pause, backend }: CloseDeadlines): Promise<void> {
		this.#lifetime.abort(new EngineError('conflict', 'The engine is shutting down.'))
		const active = [...this.#active.entries()]
		// Driving stops at once on the abort; work that ignores it doesn't get to hold up the pauses.
		const describing = [...this.#describing.values()]
		await settleWithin(Promise.allSettled([...active.map(([, run]) => run.work), ...describing]), pause)
		await Promise.allSettled(active.map(([id, run]) => this.#pauseOnClose(id, run, pause)))
		await settleWithin(this.#store.flush(), backend)
		await abortable(this.#backend.close(backend), backend)
	}

	async #pauseOnClose(id: RunId, { sandbox, channel }: ActiveRun, signal: AbortSignal): Promise<void> {
		const record = this.get(id)
		// A paused run whose resume was cut short is still paused.
		if (finishedStatuses.has(record.status) || record.status === 'paused') return
		if (!sandbox || record.status !== 'running') {
			await this.#update(id, { status: 'restartable', sandbox: undefined, error: 'The engine shut down while the run was starting.' })
			return
		}
		try {
			await abortable(channel?.stopPolls(signal) ?? Promise.resolve(), signal)
			const paused = await abortable(sandbox.pause(signal), signal)
			await this.#update(id, { status: 'paused', paused })
		} catch (error) {
			await this.#update(id, { status: 'restartable', sandbox: undefined, error: `Pausing on shutdown failed: ${messageOf(error)}` })
		}
	}

	/** Resumes a run's paused sandbox and marks the run running. `runSignal` is the drive's own. */
	async #reattach(
		id: RunId,
		paused: PausedSandbox,
		active: ActiveRun,
		signal: AbortSignal,
		runSignal: AbortSignal,
	): Promise<SandboxChannel> {
		const sandbox = await this.#backend.resume(paused, AbortSignal.any([signal, runSignal]))
		const ref: SandboxRef = { backend: this.#backend.name, id: sandbox.id }
		const channel = this.#attach(active, sandbox)
		await this.#update(id, { status: 'running', paused: undefined }, ['paused']).catch(async (error: unknown) => {
			// The run was stopped while its sandbox was being resumed: nobody else will remove it.
			if (error instanceof EngineError) await this.#discard(id, ref)
			throw error
		})
		runSignal.throwIfAborted()
		return channel
	}

	/** Makes `sandbox` the run's, with a channel to its mailbox. The only place an attempt gets them. */
	#attach(active: ActiveRun, sandbox: Sandbox): SandboxChannel {
		const channel = new SandboxChannel(sandbox, this.#layout.mailbox)
		active.sandbox = sandbox
		active.channel = channel
		return channel
	}

	/** Makes the sandbox, uploads and sets up the workflow, starts the runtime and follows it. */
	async #start(id: RunId, file: string, active: ActiveRun, signal: AbortSignal): Promise<void> {
		const record = this.get(id)
		const { config } = record
		const start = await this.#store.start(record)
		const sandbox = await this.#backend.create(config.sandbox, signal)
		const ref: SandboxRef = { backend: this.#backend.name, id: sandbox.id }
		const channel = this.#attach(active, sandbox)
		await this.#update(id, { sandbox: ref }, ['starting']).catch(async (error: unknown) => {
			// The run was given up on while the sandbox was being made: nobody else will remove it.
			if (error instanceof EngineError) await this.#discard(id, ref)
			throw error
		})
		const setup = { tarball: this.#store.sourceOf(id), config, file, layout: this.#layout, start, env: { [runIdEnvironmentVariable]: id } }
		await setUpRuntime(sandbox, channel, setup, signal)
		await this.#update(id, { status: 'running' }, ['starting'])
		await this.#pump(id, channel, signal)
	}

	/** Follows the runtime's outbox until the run succeeds or fails. */
	async #pump(id: RunId, channel: SandboxChannel, signal: AbortSignal): Promise<void> {
		for (;;) {
			const delivery = await channel.poll(this.get(id).cursor, signal)
			if (delivery.kind === 'gone') {
				const log = await channel.logTail(signal).catch(() => '')
				throw new Error(`The runtime exited without saying how the run ended.${log ? `\n${log}` : ''}`)
			}
			const { events, requests, outcome } = sortMessages(delivery.messages)
			await this.#store.appendEvents(id, events)
			if (outcome) {
				// Saved with the cursor, so an outcome that was read can't be lost. The sandbox goes after.
				const { sandbox } = this.get(id)
				await this.#update(id, { ...outcome, cursor: delivery.cursor, sandbox: undefined, pending: [] }, ['running'])
				if (sandbox) await this.#discard(id, sandbox)
				return
			}
			await this.#update(
				id,
				(record) => ({
					cursor: delivery.cursor,
					pending: [...record.pending, ...requests.filter((request) => !record.pending.some((known) => known.id === request.id))],
				}),
				['running'],
			)
			for (const request of requests) this.#schedule(id, channel, request, signal)
		}
	}

	/** Wakes are answered by the engine's own clock, through the channel of the attempt that asked. */
	#schedule(id: RunId, channel: SandboxChannel, request: RuntimeRequest, signal: AbortSignal): void {
		if (request.kind !== 'wake') return
		wakeAt(new Date(request.at), () => void this.#wake(id, channel, request, signal), signal, this.#now)
	}

	async #wake(id: RunId, channel: SandboxChannel, request: WakeRequest, signal: AbortSignal): Promise<void> {
		// A wake of an attempt that ended, while its drive is still cleaning up, isn't for the next one.
		if (this.#active.get(id)?.channel !== channel) return
		try {
			await this.#deliver(id, request.id, {}, signal)
		} catch (error) {
			if (!signal.aborted) this.#log(`Waking run ${id} for ${request.id} failed: ${messageOf(error)}`)
		}
	}

	async #deliver(id: RunId, requestId: string, answer: Answer, signal: AbortSignal): Promise<void> {
		const channel = this.#active.get(id)?.channel
		if (!channel) throw new EngineError('conflict', `Run ${id} isn't running in this engine.`)
		await channel.answer(requestId, answer, signal)
		await this.#update(id, (record) => ({ pending: record.pending.filter((pending) => pending.id !== requestId) }))
	}

	/** Stops a run once the caller has checked it may. Bounded by the cleanup timeout, not by the caller. */
	async #stop(id: RunId): Promise<RunRecord> {
		await this.#halt(id, this.#cleanupSignal())
		const current = this.get(id)
		// The run may have ended while it was being halted; how it ended stands.
		if (finishedStatuses.has(current.status)) return current
		const { sandbox } = current
		const stopped = await this.#update(id, { status: 'stopped', sandbox: undefined, paused: undefined, pending: [] })
		if (sandbox) await this.#discard(id, sandbox)
		return stopped
	}

	/**
	 * Drives a run in the background. A failure fails the run; an abort leaves it to whoever
	 * aborted. When the work ends, its signal aborts, which cancels the run's wake timers so none
	 * of them answers a later attempt.
	 */
	#drive(id: RunId, work: (active: ActiveRun, signal: AbortSignal) => Promise<void>): void {
		const controller = new AbortController()
		const signal = AbortSignal.any([this.#lifetime.signal, controller.signal])
		const active: ActiveRun = { controller, work: Promise.resolve() }
		this.#active.set(id, active)
		active.work = work(active, signal)
			.catch((error: unknown) => (signal.aborted ? undefined : this.#fail(id, error)))
			.catch((error: unknown) => {
				this.#log(`Couldn't save that run ${id} failed: ${messageOf(error)}`)
			})
			.finally(() => {
				controller.abort(new Error(`Run ${id} isn't driven any more.`))
				if (this.#active.get(id) === active) this.#active.delete(id)
			})
	}

	/** Records that a run failed, then removes its sandbox. */
	async #fail(id: RunId, error: unknown): Promise<void> {
		const { sandbox } = this.get(id)
		await this.#update(id, { status: 'failed', error: messageOf(error), sandbox: undefined, pending: [] })
		if (sandbox) await this.#discard(id, sandbox)
	}

	/**
	 * Removes a sandbox no run needs any more. A failure is only logged, and a sandbox on another
	 * backend is left alone: the next start's reconcile on its backend removes it.
	 */
	async #discard(id: RunId, sandbox: SandboxRef): Promise<void> {
		if (sandbox.backend !== this.#backend.name) {
			this.#log(`Left sandbox ${sandbox.id} of run ${id} to ${sandbox.backend}; this engine runs ${this.#backend.name}.`)
			return
		}
		await this.#backend.remove(sandbox.id, this.#cleanupSignal()).catch((error: unknown) => {
			this.#log(`Removing sandbox ${sandbox.id} of run ${id} failed: ${messageOf(error)}`)
		})
	}

	/** Bounds cleanup that has to finish whatever the caller does, up to a shutdown. */
	#cleanupSignal(): AbortSignal {
		return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(cleanupTimeoutMs)])
	}

	/** Stops driving a run and waits until that has stopped. */
	async #halt(id: RunId, signal: AbortSignal): Promise<void> {
		const active = this.#active.get(id)
		if (!active) return
		active.controller.abort(new Error(`Run ${id} was stopped.`))
		await settleWithin(active.work, signal)
	}

	/** The run, when it's in one of `statuses`. Throws `conflict` otherwise. */
	#requireStatus(id: string, statuses: readonly RunStatus[]): RunRecord {
		const record = this.get(id)
		if (!statuses.includes(record.status)) throw new EngineError('conflict', `Run ${id} is ${record.status}.`)
		return record
	}

	/** The caller's signal, aborted on shutdown as well. */
	#withLifetime(signal: AbortSignal): AbortSignal {
		return AbortSignal.any([signal, this.#lifetime.signal])
	}

	/** Refuses new work once a shutdown has begun. */
	#assertOpen(): void {
		if (this.#lifetime.signal.aborted) throw new EngineError('conflict', 'The engine is shutting down.')
	}

	/**
	 * Applies a change to the record as it is now, so concurrent changes don't overwrite each other.
	 * With `from`, only while the run is in one of those statuses: work that finishes after a stop
	 * or a shutdown gave up on it can't undo what they wrote.
	 */
	async #update(id: RunId, change: RunChange | ((record: RunRecord) => RunChange), from?: readonly RunStatus[]): Promise<RunRecord> {
		const current = this.get(id)
		if (from && !from.includes(current.status)) throw new EngineError('conflict', `Run ${id} is ${current.status} by now.`)
		const next = applyRunChange(current, typeof change === 'function' ? change(current) : change, this.#now())
		this.#records.set(id, next)
		await this.#store.save(next)
		return next
	}
}

/** Why a resume was refused once the run's drive was aborted, by a stop or a shutdown. */
function cutShort(id: string, signal: AbortSignal): EngineError {
	return new EngineError('conflict', `Resuming run ${id} was cut short: ${messageOf(signal.reason)}`)
}

/** The event that marks where a restarted run began again. */
function restartEvent(at: Date): RuntimeEvent {
	return { id: `restart-${at.getTime().toString(36)}`, type: 'run-restarted', at: at.toISOString() }
}

/** One poll's messages, sorted. */
interface SortedMessages {
	readonly events: RuntimeEvent[]
	readonly requests: RuntimeRequest[]
	readonly outcome?: RunChange
}

/** Splits what one poll delivered into events to keep, requests to wait on, and how the run ended. */
function sortMessages(messages: readonly RuntimeMessage[]): SortedMessages {
	const events: RuntimeEvent[] = []
	const requests: RuntimeRequest[] = []
	let outcome: RunChange | undefined
	for (const message of messages) {
		if (message.type === 'event') events.push(message.event)
		else if (message.type === 'request') requests.push(message.request)
		else if (message.type === 'succeeded') outcome = { status: 'succeeded' }
		else if (message.type === 'skipped') outcome = { status: 'skipped', reason: message.reason }
		else if (message.type === 'failed') outcome = { status: 'failed', error: message.error }
	}
	return { events, requests, ...(outcome ? { outcome } : {}) }
}
