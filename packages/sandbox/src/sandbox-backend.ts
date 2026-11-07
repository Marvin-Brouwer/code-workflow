import type { BackendName, PausedSandbox } from './paused-sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import type { SandboxSpec } from './sandbox-spec.ts';

/** A sandbox a backend still holds, found by {@link SandboxBackend.list}. */
export interface HeldSandbox {
    readonly id: string;
    readonly state: 'running' | 'paused';
}

/**
 * Creates, resumes and cleans up sandboxes on one kind of backend.
 *
 * `close` leaves nothing running: it aborts calls still in flight and destroys every sandbox this
 * backend created or resumed that isn't paused yet. Pause the ones worth keeping first.
 */
export interface SandboxBackend {
    readonly name: BackendName;
    create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox>;
    /** Throws a `BackendMismatchError` when another backend made the pause. */
    resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox>;
    /** Every mesh-flow sandbox this backend holds, running or paused, also from earlier processes. */
    list(signal: AbortSignal): Promise<HeldSandbox[]>;
    /** Removes a sandbox by id, running or paused. Removing one that is already gone is fine. */
    remove(id: string, signal: AbortSignal): Promise<void>;
    close(signal: AbortSignal): Promise<void>;
}
