import { RuntimeRequest, TriggerRef } from '@mesh-flow/protocol'
import { BackendName, PausedSandbox, SandboxSpec } from '@mesh-flow/sandbox'
import { z } from 'zod'
import { AppName } from '../apps/names.mts'
import { RunId } from './run-id.mts'

/**
 * Where a run is in its life:
 *
 * | Status | Meaning |
 * |---|---|
 * | `starting` | its sandbox is being made and the app uploaded |
 * | `running` | the runtime runs in the sandbox; it may wait on requests in `pending` |
 * | `paused` | its sandbox is paused to disk, with the runtime in it; `resume` picks it up |
 * | `restartable` | its sandbox is gone; `restart` runs it again from the top |
 * | `succeeded`, `failed`, `stopped` | done; nothing of it runs any more |
 * | `skipped` | done without doing anything: the webhook delivery that started it isn't for its workflow |
 */
export const RunStatus = z.enum(['starting', 'running', 'paused', 'restartable', 'succeeded', 'failed', 'stopped', 'skipped'])
export type RunStatus = z.infer<typeof RunStatus>

/** Statuses a run never leaves on its own. */
export const finishedStatuses: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'stopped', 'skipped'])

/**
 * The app version a run runs, kept as a tarball next to the record, so a restart runs the same
 * code in the same sandbox even after another version was deployed.
 */
export const RunApp = z.object({
	name: AppName,
	version: z.string().min(1),
	/** The built entry file the sandbox starts with `node`. */
	entry: z.string().min(1),
	sandbox: SandboxSpec,
})
export type RunApp = z.infer<typeof RunApp>

/** Everything the engine knows about one run. Stored as JSON, so it survives a restart. */
export const RunRecord = z.object({
	id: RunId,
	workflow: z.string().min(1),
	/** The trigger that started the run, from a delivery, a schedule or the CLI. */
	trigger: TriggerRef,
	/** Names what the run was started for, such as a webhook delivery: a second start with it reuses this run. */
	key: z.string().min(1).optional(),
	app: RunApp,
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
	/** Why a skipped run was skipped. */
	reason: z.string().optional(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type RunRecord = z.infer<typeof RunRecord>
