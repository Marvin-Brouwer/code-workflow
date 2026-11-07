import { z } from 'zod';
import { SandboxSpec } from './sandbox-spec.ts';

/** The backends this package has. */
export const BackendName = z.enum(['e2b', 'microsandbox', 'gvisor']);
export type BackendName = z.infer<typeof BackendName>;

/**
 * A sandbox paused to disk: plain JSON, so the engine can keep it in a run record and read it
 * back after a restart with `PausedSandbox.parse`.
 *
 * It names the backend that made it, because a pause only resumes there.
 */
export const PausedSandbox = z.object({
    backend: BackendName,
    id: z.string().min(1),
    spec: SandboxSpec,
    /** The backend's own name for the saved state, where that isn't the id (microsandbox). */
    snapshot: z.string().min(1).optional(),
});
export type PausedSandbox = z.infer<typeof PausedSandbox>;

/** Thrown when a sandbox is resumed on another backend than the one that paused it. */
export class BackendMismatchError extends Error {
    override readonly name = 'BackendMismatchError';

    constructor(readonly paused: BackendName, readonly backend: BackendName) {
        super(`This sandbox was paused by ${paused} and can only be resumed there, not on ${backend}.`);
    }
}

/** Throws a {@link BackendMismatchError} unless `paused` was made by `backend`. */
export function assertPausedBy(paused: PausedSandbox, backend: BackendName): void {
    if (paused.backend !== backend) throw new BackendMismatchError(paused.backend, backend);
}
