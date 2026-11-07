import { z } from 'zod'
import { BackendName } from './backend-name.mts'
import { SandboxSpec } from './sandbox-spec.mts'

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
	/** The backend's own name for the saved state: a microsandbox snapshot or a gVisor checkpoint. */
	snapshot: z.string().min(1).optional(),
})
export type PausedSandbox = z.infer<typeof PausedSandbox>
