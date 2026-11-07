import type { BackendName } from './backend-name.mts'
import type { PausedSandbox } from './paused-sandbox.mts'
import type { Sandbox } from './sandbox.mts'
import type { SandboxSpec } from './sandbox-spec.mts'

/** A sandbox a backend still holds, found by {@link SandboxBackend.list}. */
export interface HeldSandbox {
	readonly id: string
	readonly state: 'running' | 'paused'
}

/**
 * Creates, resumes and cleans up sandboxes on one kind of backend.
 *
 * `close` leaves nothing running: it aborts calls still in flight and destroys every sandbox this
 * backend created or resumed that isn't paused yet. Pause the ones worth keeping first.
 */
export interface SandboxBackend {
	readonly name: BackendName
	/** Starts a new sandbox. Every call makes a new one, with a new id. */
	create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox>
	/**
	 * Starts a paused sandbox again, with the same id. Throws a `BackendMismatchError` when another
	 * backend made the pause, and refuses a sandbox that is already running here.
	 */
	resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox>
	/** Every mesh-flow sandbox this backend holds, running or paused, also from earlier processes. */
	list(signal: AbortSignal): Promise<HeldSandbox[]>
	/** Removes a sandbox by id, running or paused. Removing one that is already gone is fine. */
	remove(id: string, signal: AbortSignal): Promise<void>
	/** Destroys every running sandbox and waits for cleanup in flight, as long as `signal` allows. */
	close(signal: AbortSignal): Promise<void>
}
