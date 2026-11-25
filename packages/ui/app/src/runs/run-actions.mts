import { send, type Answer } from '../_shared/api.mts'
import { RunRecord, type RunStatus } from '../_shared/runs.mts'

/** What a person can do to a run, as the engine's routes of those names. */
export type RunAction = 'stop' | 'resume' | 'restart' | 'archive' | 'unarchive'

/** An action as a button shows it. */
export interface ShownRunAction {
	readonly action: RunAction
	readonly label: string
}

/** An action, and the runs the engine takes it for. */
interface RunActionRule extends ShownRunAction {
	readonly takes: (record: RunRecord) => boolean
}

/** The runs the engine's `stop` takes. */
const stoppableStatuses: ReadonlySet<RunStatus> = new Set(['starting', 'running', 'paused', 'restartable'])

/** The runs the engine's `restart` takes. */
const continuableStatuses: ReadonlySet<RunStatus> = new Set(['restartable', 'failed', 'stopped'])

/** A run that's over, as the engine's set of the same name: nothing of it runs any more, so it can be archived. */
const finishedStatuses: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'stopped', 'skipped'])

/** Whether a run is in the archive. */
export function isArchived(record: RunRecord): boolean {
	return record.archivedAt !== undefined
}

/** What can be done to a run, and to which runs the engine takes it. */
const actions: readonly RunActionRule[] = [
	{
		action: 'stop',
		label: 'Stop',
		takes: ({ status }) => stoppableStatuses.has(status),
	},
	{
		action: 'resume',
		label: 'Resume',
		takes: ({ status }) => status === 'paused',
	},
	// A restart runs the code again, but finished loops keep their results and branches and pull
	// requests are reused: it continues.
	{
		action: 'restart',
		label: 'Continue',
		takes: ({ status }) => continuableStatuses.has(status),
	},
	{
		action: 'archive',
		label: 'Archive',
		takes: (record) => finishedStatuses.has(record.status) && !isArchived(record),
	},
	{
		action: 'unarchive',
		label: 'Unarchive',
		takes: isArchived,
	},
]

/** The actions the engine takes for `record` now, of those in `shown`, in a fixed order. */
export function runActions(record: RunRecord, shown: readonly RunAction[]): ShownRunAction[] {
	return actions.filter(({ action, takes }) => shown.includes(action) && takes(record))
}

/** Asks the engine to do `action` to run `id`. A refusal, such as a run that changed meanwhile, is an answer. */
export function actOn(id: string, action: RunAction, abortSignal: AbortSignal): Promise<Answer<RunRecord>> {
	return send('POST', `/engine/runs/${encodeURIComponent(id)}/${action}`, {}, RunRecord, abortSignal)
}
