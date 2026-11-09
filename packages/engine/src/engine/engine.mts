import { mergeUsage, type AcceptedCall, type Gateway, type RunUsage } from '@mesh-flow/gateway'
import {
	runIdEnvironmentVariable,
	type Answer,
	type CallAnswer,
	type CallMessage,
	type RunStart,
	type RuntimeEvent,
	type RuntimeMessage,
	type RuntimeRequest,
	type TriggerRef,
	type WakeRequest,
} from '@mesh-flow/protocol'
import { abortable, SandboxSpec, type PausedSandbox, type Sandbox, type SandboxBackend } from '@mesh-flow/sandbox'
import type { AppStore } from '../apps/app-store.mts'
import { hasErrorCode, messageOf } from '../errors.mts'
import { SandboxChannel } from '../mailbox/sandbox-channel.mts'
import { applyRunChange, type RunChange } from '../runs/run-change.mts'
import { newRunId, RunId } from '../runs/run-id.mts'
import { finishedStatuses, type RunApp, type RunRecord, type RunStatus } from '../runs/run-record.mts'
import type { RunStore } from '../runs/run-store.mts'
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
	/** The deployed apps runs start from. */
	readonly apps: AppStore
	/** Where things go inside a sandbox. */
	readonly layout?: SandboxLayout
	/** Where the engine reports what it did on its own, such as reconciling. Default: nowhere. */
	readonly log?: (message: string) => void
	/** The engine's clock, for wakes and timestamps. Default: the system clock. */
	readonly now?: () => Date
	/**
	 * Runs the calls that need a credential: host tools and model calls. Without it, a run gets no
	 * gateway endpoint, and its agents have no model to run on.
	 */
	readonly gateway?: Gateway
}

/** Which trigger of which app starts a run, and with what. */
export interface StartRunOptions {
	/** The deployed app; the run starts on its current version. */
	readonly app: string
	/** One of the triggers the app's current version lists. Its workflow is the one that runs. */
	readonly trigger: TriggerRef
	/**
	 * For a user trigger or a schedule, the run's parameters, which the runtime checks against the
	 * workflow's; for a webhook, the delivery's payload, which the trigger's schema turns into them.
	 * Without it, a schedule runs with its own parameters.
	 */
	readonly input?: unknown
	/** Names what the run is for, such as a webhook delivery. A run with this key already is returned instead. */
	readonly key?: string
	/** Bounds copying the app and saving the record. The run itself goes on in the background. */
	readonly abortSignal: AbortSignal
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
	/** The gateway calls running now, by request id, so the runtime can cancel them. */
	readonly calls: Map<string, AbortController>
}

/** Which sandbox a run record points at. */
type SandboxRef = NonNullable<RunRecord['sandbox']>

/** How long cleaning up after a run, such as removing its sandbox, may take. */
const cleanupTimeoutMs = 60_000

/** How long starting a run from a trigger may take: copying the app and saving the record. */
export const startRunTimeoutMs = 60_000

/**
 * The host process's view of runs: it starts each run in its own sandbox, relays requests and
 * answers through the sandbox's mailbox, pauses everything on shutdown and reconciles on start.
 * It never runs workflow code itself.
 *
 * @example
 * ```ts
 * const store = openRunStore(path.join(home, 'runs'))
 * const apps = await openAppStore(path.join(home, 'apps'), abortSignal)
 * const engine = await Engine.open({ backend, store, apps }, abortSignal)
 * const run = await engine.startRun({ app: 'team', trigger: { kind: 'user', id: 'develop' }, input: { story: 'ABC-1' }, abortSignal })
 * // ... later, on Ctrl+C:
 * await engine.close({ pause: AbortSignal.timeout(30_000), backend: AbortSignal.timeout(60_000) })
 * ```
 */
export class Engine {
	readonly #backend: SandboxBackend
	readonly #store: RunStore
	readonly #apps: AppStore
	readonly #layout: SandboxLayout
	readonly #log: (message: string) => void
	readonly #now: () => Date
	readonly #gateway: Gateway | undefined
	readonly #records = new Map<RunId, RunRecord>()
	readonly #active = new Map<RunId, ActiveRun>()
	readonly #lifetime = new AbortController()
	/** Input requests an answer is on its way to, as `<run>/<request>`, so a second answer is refused. */
	readonly #answering = new Set<string>()
	/** Runs with a key that are being started, so a second start with the key waits for the first. */
	readonly #keyed = new Map<string, Promise<RunRecord>>()
	#closing: Promise<void> | undefined

	private constructor(options: EngineOptions) {
		this.#backend = options.backend
		this.#store = options.store
		this.#apps = options.apps
		this.#layout = options.layout ?? defaultSandboxLayout
		this.#log = options.log ?? (() => undefined)
		this.#now = options.now ?? (() => new Date())
		this.#gateway = options.gateway
	}

	/** Loads the run records and reconciles them with the backend. Resumes nothing. */
	static async open(options: EngineOptions, signal: AbortSignal): Promise<Engine> {
		const engine = new Engine(options)
		const { records, problems, orphans } = await options.store.loadAll()
		for (const problem of problems) engine.#log(problem)
		for (const id of orphans) {
			// Left by a start that died before its record was saved, with its app and maybe a webhook's payload.
			await options.store.removeRun(id).catch((error: unknown) => {
				engine.#log(`Removing ${id}, which has no run record, failed: ${messageOf(error)}`)
			})
		}
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
	 * Starts a run through one of an app's triggers, on the app's current version. Returns once the
	 * record is saved; the sandbox is made and the app unpacked in the background, so follow the
	 * run's status. With a `key`, a run that has it already is returned instead, also while it's
	 * being started.
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
		const waitSignal = this.#withLifetime(options.abortSignal)
		const deployed = this.#apps.current(options.app)
		if (deployed === undefined) throw new EngineError('not-found', `There is no app ${options.app}: deploy it first.`)
		const { kind, id: triggerId } = options.trigger
		const listed = deployed.manifest.description.triggers.find((known) => known.kind === kind && known.id === triggerId)
		if (listed === undefined) {
			throw new EngineError('not-found', `Version ${deployed.version} of ${options.app} has no ${kind} trigger ${triggerId}.`)
		}
		const sandbox = SandboxSpec.safeParse(deployed.manifest.description.sandbox)
		if (!sandbox.success) {
			throw new EngineError(
				'invalid',
				`Version ${deployed.version} of ${options.app} asks for a sandbox this engine can't make: deploy it again.`,
			)
		}
		const unavailable = await this.#gateway?.unavailableModels(deployed.manifest.description.models, waitSignal)
		if (unavailable !== undefined && unavailable.length > 0) {
			throw new EngineError('unavailable', `${options.app} can't run now, so no run was started:\n${unavailable.join('\n')}`)
		}
		const app: RunApp = {
			name: deployed.name,
			version: deployed.version,
			entry: deployed.manifest.entry,
			sandbox: sandbox.data,
			tools: deployed.manifest.description.tools,
		}
		const id = newRunId()
		// A copy of its own, so the run keeps its code when the app is deployed again or removed.
		await this.#store.saveApp(id, deployed.tarball, waitSignal).catch(async (error: unknown) => {
			await this.#store.removeRun(id).catch(() => undefined)
			// Removed between finding it and copying it.
			if (hasErrorCode(error, 'ENOENT')) throw new EngineError('not-found', `The app ${options.app} was removed.`)
			throw error
		})
		waitSignal.throwIfAborted()
		// Only the kind and the id, whatever else the caller's object holds: this goes into the record.
		const trigger: TriggerRef = { kind, id: triggerId }
		const start: RunStart = {
			mode: 'run',
			workflow: listed.workflow,
			trigger,
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
			workflow: listed.workflow,
			trigger,
			...(options.key === undefined ? {} : { key: options.key }),
			app,
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
			await this.#start(id, active, runSignal)
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
			await this.#start(record.id, active, runSignal)
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
		const sandbox = await this.#backend.resume(paused, AbortSignal.any([signal, runSignal]))
		const ref: SandboxRef = { backend: this.#backend.name, id: sandbox.id }
		const channel = this.#attach(active, sandbox)
		await this.#update(id, { status: 'running', paused: undefined }, ['paused']).catch(async (error: unknown) => {
			// The run was stopped while its sandbox was being resumed: nobody else will remove it.
			if (error instanceof EngineError) await this.#discard(id, ref)
			throw error
		})
		runSignal.throwIfAborted()
		await this.#answerInterrupted(id, channel, runSignal)
		return channel
	}

	/** Makes `sandbox` the run's, with a channel to its mailbox. The only place an attempt gets them. */
	#attach(active: ActiveRun, sandbox: Sandbox): SandboxChannel {
		const channel = new SandboxChannel(sandbox, this.#layout.mailbox)
		active.sandbox = sandbox
		active.channel = channel
		return channel
	}

	/** Makes the sandbox, uploads the app, starts the runtime and follows it. */
	async #start(id: RunId, active: ActiveRun, abortSignal: AbortSignal): Promise<void> {
		const record = this.get(id)
		const { app } = record
		const start = await this.#store.loadStart(record)
		const sandbox = await this.#backend.create(app.sandbox, abortSignal)
		const ref: SandboxRef = { backend: this.#backend.name, id: sandbox.id }
		const channel = this.#attach(active, sandbox)
		await this.#update(id, { sandbox: ref }, ['starting']).catch(async (error: unknown) => {
			// The run was given up on while the sandbox was being made: nobody else will remove it.
			if (error instanceof EngineError) await this.#discard(id, ref)
			throw error
		})
		const grant = await this.#gateway?.openRun(id, app.tools, abortSignal)
		const setup = {
			tarball: this.#store.appOf(id),
			entry: app.entry,
			layout: this.#layout,
			start,
			env: { [runIdEnvironmentVariable]: id },
			grant,
		}
		await setUpRuntime(sandbox, channel, setup, abortSignal)
		await this.#update(id, { status: 'running' }, ['starting'])
		await this.#pump(id, channel, abortSignal)
	}

	/** Follows the runtime's outbox until the run succeeds or fails. */
	async #pump(id: RunId, channel: SandboxChannel, signal: AbortSignal): Promise<void> {
		for (;;) {
			const delivery = await channel.poll(this.get(id).cursor, signal)
			if (delivery.kind === 'gone') {
				const log = await channel.logTail(signal).catch(() => '')
				throw new Error(`The runtime exited without saying how the run ended.${log ? `\n${log}` : ''}`)
			}
			const { events, requests, calls, cancels, outcome } = sortMessages(delivery.messages)
			await this.#store.appendEvents(id, events)
			if (outcome) {
				// Saved with the cursor, so an outcome that was read can't be lost. The sandbox goes after.
				const { sandbox } = this.get(id)
				const usage = await this.#closeGateway(id)
				await this.#update(id, { ...outcome, cursor: delivery.cursor, sandbox: undefined, pending: [], usage }, ['running'])
				if (sandbox) await this.#discard(id, sandbox)
				return
			}
			// Taken before the cursor moves past them, so a call that was read is never lost.
			const accepted = await Promise.all(calls.map(async (call) => ({ call, accepted: await this.#accept(id, call, signal) })))
			await this.#update(
				id,
				(record) => ({
					cursor: delivery.cursor,
					pending: [...record.pending, ...requests.filter((request) => !record.pending.some((known) => known.id === request.id))],
				}),
				['running'],
			)
			for (const request of requests) this.#schedule(id, channel, request, signal)
			for (const taken of accepted) this.#answerCall(id, channel, taken.call, taken.accepted, signal)
			// After the calls of this delivery are running, so a cancel read with its call still stops it.
			for (const cancelled of cancels) this.#active.get(id)?.calls.get(cancelled)?.abort(new Error('The runtime cancelled the call.'))
		}
	}

	/** Takes a gateway call. Without a gateway, the call gets an error and no next token. */
	async #accept(id: RunId, call: CallMessage, abortSignal: AbortSignal): Promise<AcceptedCall> {
		if (this.#gateway === undefined) {
			const answer: CallAnswer = { outcome: { ok: false, error: 'This engine has no gateway.' } }
			return { answer: () => Promise.resolve(answer) }
		}
		return this.#gateway.accept(id, call, abortSignal)
	}

	/**
	 * Runs a gateway call in the background and answers it through the channel of the attempt that
	 * made it. A call stopped by a stop or a shutdown isn't answered: it stays in flight with the
	 * gateway, which answers it as interrupted when the run is resumed. A call that shows someone
	 * else has the run's tokens fails the run.
	 */
	#answerCall(id: RunId, channel: SandboxChannel, call: CallMessage, accepted: AcceptedCall, abortSignal: AbortSignal): void {
		if (accepted.compromised !== undefined) {
			this.#log(`Run ${id}: ${accepted.compromised}`)
			void this.#halt(id, this.#cleanupSignal())
				.then(() => this.#fail(id, new Error(accepted.compromised)))
				.catch((error: unknown) => {
					this.#log(`Couldn't fail run ${id} after a bad token: ${messageOf(error)}`)
				})
			return
		}
		const calls = this.#active.get(id)?.calls
		const cancel = new AbortController()
		calls?.set(call.id, cancel)
		void accepted
			.answer(AbortSignal.any([abortSignal, cancel.signal]))
			.then(async (answer) => {
				abortSignal.throwIfAborted()
				await this.#answerFromGateway(id, channel, call.id, answer, abortSignal)
			})
			.catch(async (error: unknown) => {
				if (abortSignal.aborted) return
				// The runtime would wait for the answer, and its token, until the run ends.
				this.#log(`Answering call ${call.id} of run ${id} failed: ${messageOf(error)}`)
				await this.#halt(id, this.#cleanupSignal())
				await this.#fail(id, new Error(`Answering gateway call ${call.id} failed: ${messageOf(error)}`))
			})
			.catch((error: unknown) => {
				this.#log(`Couldn't fail run ${id} after a call's answer failed: ${messageOf(error)}`)
			})
			.finally(() => {
				calls?.delete(call.id)
			})
	}

	/**
	 * Writes a gateway answer to the inbox, then lets the gateway forget the call. Forgetting it isn't
	 * cut short by a stop: once the answer is in, a resume mustn't answer the call again.
	 */
	async #answerFromGateway(
		id: RunId,
		channel: SandboxChannel,
		requestId: string,
		answer: CallAnswer,
		abortSignal: AbortSignal,
	): Promise<void> {
		await channel.answer(requestId, { value: answer }, abortSignal)
		await this.#gateway?.settle(id, requestId, this.#cleanupSignal())
	}

	/**
	 * Answers the calls a resumed run made before the engine stopped, as interrupted. The gateway
	 * keeps them, so one read again from where the cursor was saved gets the same answer.
	 */
	async #answerInterrupted(id: RunId, channel: SandboxChannel, abortSignal: AbortSignal): Promise<void> {
		for (const call of (await this.#gateway?.interrupted(id, abortSignal)) ?? []) {
			await channel.answer(call.id, { value: call.answer }, abortSignal)
		}
	}

	/** Closes the run's gateway endpoints and returns its usage, with that of earlier attempts. */
	async #closeGateway(id: RunId): Promise<RunUsage | undefined> {
		if (this.#gateway === undefined) return this.get(id).usage
		const used = await this.#gateway.closeRun(id, this.#cleanupSignal()).catch((error: unknown) => {
			this.#log(`Closing the gateway endpoints of run ${id} failed: ${messageOf(error)}`)
			return {}
		})
		const earlier = this.get(id).usage
		if (earlier === undefined && Object.keys(used).length === 0) return undefined
		return mergeUsage(earlier ?? {}, used)
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
		const usage = await this.#closeGateway(id)
		const stopped = await this.#update(id, { status: 'stopped', sandbox: undefined, paused: undefined, pending: [], usage })
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
		const active: ActiveRun = { controller, work: Promise.resolve(), calls: new Map() }
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
		const usage = await this.#closeGateway(id)
		await this.#update(id, { status: 'failed', error: messageOf(error), sandbox: undefined, pending: [], usage })
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
	readonly calls: CallMessage[]
	/** The ids of calls the runtime stopped waiting for. */
	readonly cancels: string[]
	readonly outcome?: RunChange
}

/** Splits what one poll delivered into events to keep, requests to wait on, and how the run ended. */
function sortMessages(messages: readonly RuntimeMessage[]): SortedMessages {
	const events: RuntimeEvent[] = []
	const requests: RuntimeRequest[] = []
	const calls: CallMessage[] = []
	const cancels: string[] = []
	let outcome: RunChange | undefined
	for (const message of messages) {
		if (message.type === 'event') events.push(message.event)
		else if (message.type === 'request') requests.push(message.request)
		else if (message.type === 'call') calls.push(message)
		else if (message.type === 'cancel') cancels.push(message.id)
		else if (message.type === 'succeeded') outcome = { status: 'succeeded' }
		else if (message.type === 'skipped') outcome = { status: 'skipped', reason: message.reason }
		else if (message.type === 'failed') outcome = { status: 'failed', error: message.error }
	}
	return { events, requests, calls, cancels, ...(outcome ? { outcome } : {}) }
}
