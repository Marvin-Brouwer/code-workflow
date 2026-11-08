import {
	runIdEnvironmentVariable,
	type Answer,
	type RuntimeEvent,
	type RuntimeMessage,
	type RuntimeRequest,
	type WakeRequest,
} from '@mesh-flow/protocol'
import { abortable, type Command, type ExecResult, type Sandbox, type SandboxBackend } from '@mesh-flow/sandbox'
import { messageOf } from '../errors.mts'
import { SandboxChannel } from '../mailbox/sandbox-channel.mts'
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
import { wakeAt } from './wake-timer.mts'

export interface EngineOptions {
	readonly backend: SandboxBackend
	readonly store: RunStore
	/** Where things go inside a sandbox. */
	readonly layout?: SandboxLayout
	/** Where the engine reports what it did on its own, such as reconciling. Default: nowhere. */
	readonly log?: (message: string) => void
	/** The engine's clock, for wakes and timestamps. Default: the system clock. */
	readonly now?: () => Date
}

export interface StartRunOptions {
	/** The workflow repository on the host, with its `mesh-flow.config.json`. */
	readonly directory: string
	/** The workflow's name: its file in the repository's workflows folder, without `.mts`. */
	readonly workflow: string
	readonly signal: AbortSignal
}

export interface CloseOptions {
	/** Bounds pausing the running sandboxes. Abort it to skip the pauses, as on a second Ctrl+C. */
	readonly pause: AbortSignal
	/** Bounds closing the backend, which removes every sandbox that isn't paused. */
	readonly close: AbortSignal
}

/** A run the engine is driving in this process. */
interface ActiveRun {
	readonly controller: AbortController
	sandbox?: Sandbox
	channel?: SandboxChannel
	work: Promise<void>
}

/** How long cleaning up after a run, such as removing its sandbox, may take. */
const cleanupTimeoutMs = 60_000

/**
 * The host process's view of runs: it starts each run in its own sandbox, relays requests and
 * answers through the sandbox's mailbox, pauses everything on shutdown and reconciles on start.
 * It never runs workflow code itself.
 *
 * @example
 * ```ts
 * const engine = await Engine.open({ backend, store: new RunStore(directory) }, signal)
 * const run = await engine.startRun({ directory: process.cwd(), workflow: 'develop', signal })
 * // ... later, on Ctrl+C:
 * await engine.close({ pause: AbortSignal.timeout(30_000), close: AbortSignal.timeout(60_000) })
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

	list(): RunRecord[] {
		return [...this.#records.values()]
	}

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
		const signal = this.#bind(options.signal)
		const { config, file } = await findWorkflow(options.directory, options.workflow).catch((error: unknown) => {
			throw new EngineError('invalid', messageOf(error))
		})

		const id = newRunId()
		const source = await packWorkflowSource(options.directory, this.#store.sourceOf(id), signal).catch(async (error: unknown) => {
			await this.#store.discard(id)
			if (signal.aborted) throw error
			throw new EngineError('invalid', `Packing ${options.directory} failed: ${messageOf(error)}`)
		})
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
		await this.#store.save(record)
		this.#drive(id, (active, runSignal) => this.#start(id, file, active, runSignal))
		return record
	}

	/** Answers an input request. The runtime validates the value against what it asked for. */
	async answer(id: string, requestId: string, value: unknown, signal: AbortSignal): Promise<RunRecord> {
		const record = this.get(id)
		const request = record.pending.find((pending) => pending.id === requestId)
		if (request?.kind !== 'input') throw new EngineError('not-found', `Run ${id} doesn't wait for input ${requestId}.`)
		if (record.status !== 'running') throw new EngineError('conflict', `Run ${id} is ${record.status}; resume it first.`)
		await this.#deliver(record.id, requestId, { value }, this.#bind(signal))
		return this.get(id)
	}

	/**
	 * Stops a run and removes its sandbox, also a paused one. Branches and merge requests stay.
	 * Aborting `signal` stops the waiting, not the stopping.
	 */
	stop(id: string, signal: AbortSignal): Promise<RunRecord> {
		this.#assertOpen()
		const record = this.#requireStatus(id, ['starting', 'running', 'paused', 'restartable'])
		return abortable(this.#stop(record.id), this.#bind(signal))
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
				let resumed: RunRecord
				let channel: SandboxChannel
				try {
					const sandbox = await this.#backend.resume(paused, AbortSignal.any([signal, runSignal]))
					active.sandbox = sandbox
					channel = new SandboxChannel(sandbox, this.#layout.mailbox)
					active.channel = channel
					resumed = await this.#update(record.id, { status: 'running', paused: undefined })
					runSignal.throwIfAborted()
				} catch (error) {
					reject(
						runSignal.aborted ? new EngineError('conflict', `Resuming run ${id} was cut short: ${messageOf(runSignal.reason)}`) : error,
					)
					// Once the sandbox runs, a failure fails the run. Before that, the run stays paused.
					if (active.sandbox) throw error
					return
				}
				resolve(resumed)
				for (const request of resumed.pending) this.#schedule(record.id, request, runSignal)
				await this.#pump(record.id, channel, runSignal)
			})
		})
	}

	/** Runs a run again from the top, in a new sandbox, with the code it first ran. */
	async restart(id: string, signal: AbortSignal): Promise<RunRecord> {
		this.#assertOpen()
		signal.throwIfAborted()
		const record = this.#requireStatus(id, ['restartable', 'failed', 'stopped'])
		const leftOver = record.sandbox
		const file = workflowFile(record.config, record.workflow)
		// The status changes before anything is awaited, so a second restart is refused.
		const restarted = await this.#update(record.id, {
			status: 'starting',
			sandbox: undefined,
			paused: undefined,
			cursor: 0,
			pending: [],
			error: undefined,
		})
		this.#drive(record.id, async (active, runSignal) => {
			if (leftOver) await this.#discard(record.id, leftOver.id)
			const at = this.#now()
			await this.#store.appendEvents(record.id, [
				{ id: `restart-${at.getTime().toString(36)}`, type: 'run-restarted', at: at.toISOString() },
			])
			await this.#start(record.id, file, active, runSignal)
		})
		return restarted
	}

	/**
	 * Shuts down and leaves nothing running: stops driving every run, pauses every running
	 * sandbox to disk, flushes the records and closes the backend, which removes what wasn't
	 * paused. A run that couldn't be paused becomes restartable. Calling it again waits for the
	 * same shutdown.
	 */
	close(options: CloseOptions): Promise<void> {
		this.#closing ??= this.#close(options)
		return this.#closing
	}

	async #close({ pause, close }: CloseOptions): Promise<void> {
		this.#lifetime.abort(new Error('The engine is shutting down.'))
		const active = [...this.#active.entries()]
		// Driving stops at once on the abort; work that ignores it doesn't get to hold up the pauses.
		await settleWithin(Promise.allSettled(active.map(([, run]) => run.work)), pause)
		await Promise.allSettled(active.map(([id, run]) => this.#pauseOnClose(id, run, pause)))
		await settleWithin(this.#store.flush(), close)
		await abortable(this.#backend.close(close), close)
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

	/** Makes the sandbox, uploads and sets up the workflow, starts the runtime and follows it. */
	async #start(id: RunId, file: string, active: ActiveRun, signal: AbortSignal): Promise<void> {
		const { config } = this.get(id)
		const sandbox = await this.#backend.create(config.sandbox, signal)
		active.sandbox = sandbox
		await this.#update(id, { sandbox: { backend: this.#backend.name, id: sandbox.id } })

		const channel = new SandboxChannel(sandbox, this.#layout.mailbox)
		active.channel = channel
		await channel.prepare(signal)
		await uploadWorkflowSource(sandbox, this.#store.sourceOf(id), this.#layout.workflow, signal)
		for (const command of config.setup) {
			const result = await sandbox.exec(command, { signal, cwd: this.#layout.workflow })
			if (result.exitCode !== 0) throw setupFailure(command, result)
		}
		await channel.startRuntime([...config.start, file], { signal, cwd: this.#layout.workflow, env: { [runIdEnvironmentVariable]: id } })
		await this.#update(id, { status: 'running' })
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
				await this.#update(id, { ...outcome, cursor: delivery.cursor, sandbox: undefined, pending: [] })
				if (sandbox) await this.#discard(id, sandbox.id)
				return
			}
			await this.#update(id, (record) => ({
				cursor: delivery.cursor,
				pending: [...record.pending, ...requests.filter((request) => !record.pending.some((known) => known.id === request.id))],
			}))
			for (const request of requests) this.#schedule(id, request, signal)
		}
	}

	/** Wakes are answered by the engine's own clock. */
	#schedule(id: RunId, request: RuntimeRequest, signal: AbortSignal): void {
		if (request.kind !== 'wake') return
		wakeAt(new Date(request.at), signal, () => void this.#wake(id, request, signal), this.#now)
	}

	async #wake(id: RunId, request: WakeRequest, signal: AbortSignal): Promise<void> {
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
		const { sandbox } = this.get(id)
		const stopped = await this.#update(id, { status: 'stopped', sandbox: undefined, paused: undefined, pending: [] })
		if (sandbox) await this.#discard(id, sandbox.id)
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
				this.#log(`Recording that run ${id} failed, failed: ${messageOf(error)}`)
			})
			.finally(() => {
				controller.abort(new Error(`Run ${id} isn't driven any more.`))
				if (this.#active.get(id) === active) this.#active.delete(id)
			})
	}

	async #fail(id: RunId, error: unknown): Promise<void> {
		const { sandbox } = this.get(id)
		await this.#update(id, { status: 'failed', error: messageOf(error), sandbox: undefined, pending: [] })
		if (sandbox) await this.#discard(id, sandbox.id)
	}

	/** Removes a sandbox no run needs any more. A failure is only logged: the next start's reconcile removes it. */
	async #discard(id: RunId, sandboxId: string): Promise<void> {
		await this.#backend.remove(sandboxId, this.#cleanupSignal()).catch((error: unknown) => {
			this.#log(`Removing sandbox ${sandboxId} of run ${id} failed: ${messageOf(error)}`)
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

	#requireStatus(id: string, statuses: readonly RunStatus[]): RunRecord {
		const record = this.get(id)
		if (!statuses.includes(record.status)) throw new EngineError('conflict', `Run ${id} is ${record.status}.`)
		return record
	}

	/** The caller's signal, aborted on shutdown as well. */
	#bind(signal: AbortSignal): AbortSignal {
		return AbortSignal.any([signal, this.#lifetime.signal])
	}

	#assertOpen(): void {
		if (this.#lifetime.signal.aborted) throw new EngineError('conflict', 'The engine is shutting down.')
	}

	/** Applies a change to the record as it is now, so concurrent changes don't overwrite each other. */
	async #update(id: RunId, change: RunChange | ((record: RunRecord) => RunChange)): Promise<RunRecord> {
		const current = this.get(id)
		const next = applyRunChange(current, typeof change === 'function' ? change(current) : change, this.#now())
		this.#records.set(id, next)
		await this.#store.save(next)
		return next
	}
}

/** A setup step that failed, with the end of what it wrote. */
function setupFailure(command: Command, result: ExecResult): Error {
	const output = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-20).join('\n')
	return new Error(`Setup step '${command.join(' ')}' failed with exit code ${String(result.exitCode)}:\n${output}`)
}

/** Splits what one poll delivered into events to keep, requests to wait on, and how the run ended. */
function sortMessages(messages: readonly RuntimeMessage[]): { events: RuntimeEvent[]; requests: RuntimeRequest[]; outcome?: RunChange } {
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
