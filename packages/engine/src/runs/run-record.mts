import { RuntimeRequest } from '@mesh-flow/protocol'
import { BackendName, PausedSandbox } from '@mesh-flow/sandbox'
import { z } from 'zod'
import { WorkflowConfig } from '../workflow/workflow-config.mts'
import { RunId } from './run-id.mts'

/**
 * Where a run is in its life:
 *
 * | Status | Meaning |
 * |---|---|
 * | `starting` | its sandbox is being made, the workflow uploaded and set up |
 * | `running` | the runtime runs in the sandbox; it may wait on requests in `pending` |
 * | `paused` | its sandbox is paused to disk, with the runtime in it; `resume` picks it up |
 * | `restartable` | its sandbox is gone; `restart` runs it again from the top |
 * | `succeeded`, `failed`, `stopped` | done; nothing of it runs any more |
 */
export const RunStatus = z.enum(['starting', 'running', 'paused', 'restartable', 'succeeded', 'failed', 'stopped'])
export type RunStatus = z.infer<typeof RunStatus>

/** Statuses a run never leaves on its own. */
export const finishedStatuses: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'stopped'])

/** The workflow code a run runs: the git files of a directory, kept as a tarball next to the record. */
export const RunSource = z.object({
	/** The workflow repository on the host. */
	directory: z.string().min(1),
	commit: z.string().min(1),
	/** Whether the files had changes that aren't committed. The tarball has them either way. */
	dirty: z.boolean(),
})
export type RunSource = z.infer<typeof RunSource>

/** Everything the engine knows about one run. Stored as JSON, so it survives a restart. */
export const RunRecord = z.object({
	id: RunId,
	workflow: z.string().min(1),
	source: RunSource,
	/** The repository's `mesh-flow.config.json` when the run started; a restart uses it again. */
	config: WorkflowConfig,
	status: RunStatus,
	/** The sandbox the run lives in now, also while it's paused. */
	sandbox: z.object({ backend: BackendName, id: z.string().min(1) }).optional(),
	/** Set while the run is paused. */
	paused: PausedSandbox.optional(),
	/** How many lines of the runtime's outbox the engine has handled. */
	cursor: z.int().nonnegative(),
	/** What the runtime waits on, by request id. Several can be open at once. */
	pending: z.array(RuntimeRequest),
	error: z.string().optional(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type RunRecord = z.infer<typeof RunRecord>
