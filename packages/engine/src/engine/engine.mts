import {
	runIdEnvironmentVariable,
	type Answer,
	type RuntimeEvent,
	type RuntimeMessage,
	type RuntimeRequest,
	type WakeRequest,
} from '@mesh-flow/protocol'
import { abortable, type Command, type ExecResult, type PausedSandbox, type Sandbox, type SandboxBackend } from '@mesh-flow/sandbox'
import { messageOf } from '../errors.mts'
import { SandboxChannel, tailLines } from '../mailbox/sandbox-channel.mts'
import { applyRunChange, type RunChange } from '../runs/run-change.mts'
import { newRunId, RunId } from '../runs/run-id.mts'
import { finishedStatuses, type RunRecord, type RunStatus } from '../runs/run-record.mts'
import type { RunStore } from '../runs/run-store.mts'
import { uploadWorkflowSource } from '../workflow/upload-workflow-source.mts'
import { findWorkflow, workflowFile } from '../workflow/workflow-config.mts'
import { packWorkflowSource } from '../workflow/workflow-source.mts'
import { EngineError } from './engine-error.mts'
import { reconcile } from './reconcile.mts'
import { defaultSandboxLayout, type SandboxLayout } from './sandbox-layout.mts'
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
}

/** Which workflow to start a run of. */
export interface StartRunOptions {
	/** The workflow repository on the host, with its `mesh-flow.config.json`. */
	readonly directory: string
	/** The workflow's name: its file in the repository's workflows folder, without `.mts`. */
	readonly workflow: string
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
	#closing: Promise<void> | undefined

	private constructor(options: EngineOptions) {
		this.#backend = options.backend
		this.#store = options.store
		this.#layout = options.layout ?? defaultSandboxLayout
		this.#log = options.log ?? (() => undefined)
		this.#now = options.now ?? (() => new Date())
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

	/**
	 * Starts a run of a workflow. Returns once the record is saved; the sandbox is made and set up
	 * in the background, so follow the run's status.
	 */
	async startRun(options: StartRunOptions): Promise<RunRecord> {
		this.#assertOpen()
		const signal = this.#withLifetime(options.signal)
		const { config, file } = await findWorkflow(options.directory, options.workflow).catch((error: unknown) => {
			throw new EngineError('invalid', messageOf(error))
		})

		const id = newRunId()
		const source = await packWorkflowSource(options.directory, this.#store.sourceOf(id), signal).catch(async (error: unknown) => {
			// Best effort: the pack error is the one to report.
			await this.#store.removeRun(id).catch(() => undefined)
			if (signal.aborted) throw error
			throw new EngineError('invalid', `Packing ${options.directory} failed: ${messageOf(error)}`)
		})
		if (this.#lifetime.signal.aborted) {
			await this.#store.removeRun(id).catch(() => undefined)
			this.#assertOpen()
		}
		const createdAt = this.#now().toISOString()
		const record: RunRecord = {
			id,
			workflow: options.workflow,
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
		const file = workflowFile(record.config, record.workflow)
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
		await settleWithin(Promise.allSettled(active.map(([, run]) => run.work)), pause)
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
		const channel = this.#attach(active, await this.#backend.resume(paused, AbortSignal.any([signal, runSignal])))
		await this.#update(id, { status: 'running', paused: undefined }, ['paused'])
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
		const { config } = this.get(id)
		const sandbox = await this.#backend.create(config.sandbox, signal)
		const channel = this.#attach(active, sandbox)
		await this.#update(id, { sandbox: { backend: this.#backend.name, id: sandbox.id } }, ['starting'])
		await channel.prepare(signal)
		await uploadWorkflowSource(sandbox, this.#store.sourceOf(id), this.#layout.workflow, signal)
		for (const command of config.setup) {
			const result = await sandbox.exec(command, { signal, cwd: this.#layout.workflow })
			if (result.exitCode !== 0) throw setupFailure(command, result)
		}
		await channel.startRuntime([...config.start, file], { signal, cwd: this.#layout.workflow, env: { [runIdEnvironmentVariable]: id } })
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

/** A setup step that failed, with the end of what it wrote. */
function setupFailure(command: Command, result: ExecResult): Error {
	const output = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-tailLines).join('\n')
	return new Error(`Setup step '${command.join(' ')}' failed with exit code ${String(result.exitCode)}:\n${output}`)
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
		else outcome = { status: 'failed', error: message.error }
	}
	return { events, requests, ...(outcome ? { outcome } : {}) }
}
