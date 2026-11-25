import { send, type Answer } from '../_shared/api.mts'
import { RunRecord, type RunStatus } from '../_shared/runs.mts'

/** What a person can do to a run, as the engine's routes of those names. */
export type RunAction = 'stop' | 'resume' | 'restart' | 'archive' | 'unarchive'

/** A run that's over: nothing of it runs any more, so it can be archived. */
const overStatuses: readonly RunStatus[] = ['succeeded', 'failed', 'stopped', 'skipped']

/** What can be done to a run, and to which runs the engine takes it. */
const actions: readonly { readonly action: RunAction; readonly label: string; readonly takes: (record: RunRecord) => boolean }[] = [
	{ action: 'stop', label: 'Stop', takes: ({ status }) => ['starting', 'running', 'paused', 'restartable'].includes(status) },
	{ action: 'resume', label: 'Resume', takes: ({ status }) => status === 'paused' },
	// A restart runs the code again, but finished loops keep their results and branches and pull requests are reused: it continues.
	{ action: 'restart', label: 'Continue', takes: ({ status }) => ['restartable', 'failed', 'stopped'].includes(status) },
	{ action: 'archive', label: 'Archive', takes: ({ status, archivedAt }) => overStatuses.includes(status) && archivedAt === undefined },
	{ action: 'unarchive', label: 'Unarchive', takes: ({ archivedAt }) => archivedAt !== undefined },
]

/** The actions the engine takes for `record` now, of those in `shown`, in a fixed order. */
export function runActions(record: RunRecord, shown: readonly RunAction[]): { readonly action: RunAction; readonly label: string }[] {
	return actions.filter(({ action, takes }) => shown.includes(action) && takes(record))
}

/** Asks the engine to do `action` to run `id`. A refusal, such as a run that changed meanwhile, is an answer. */
export function actOn(id: string, action: RunAction, abortSignal: AbortSignal): Promise<Answer<RunRecord>> {
	return send('POST', `/engine/runs/${encodeURIComponent(id)}/${action}`, {}, RunRecord, abortSignal)
}
