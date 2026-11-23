import type { RunRecord, RunRequest } from '../_shared/runs.mts'
import type { StepStatus } from './run-steps.mts'

/** What a run waits on, in a few words, such as `needs input`. Empty when it waits on nothing. */
export function waitsOn(pending: readonly RunRequest[]): string {
	return [...new Set(pending.map(({ kind }) => (kind === 'input' ? 'needs input' : kind === 'login' ? 'needs login' : 'waits')))].join(', ')
}

/** Whether a run waits on a person: an answer or a sign-in. */
export function needsSomeone(record: RunRecord): boolean {
	return record.pending.some(({ kind }) => kind === 'input' || kind === 'login')
}

/** The runs in the order the list shows them: those that need someone first, then the latest change first. */
export function inListOrder(records: readonly RunRecord[]): RunRecord[] {
	return records.toSorted((a, b) => Number(needsSomeone(b)) - Number(needsSomeone(a)) || b.updatedAt.localeCompare(a.updatedAt))
}

/** A step's status as the bar shows it. */
export function statusLabel(status: StepStatus): string {
	return { running: 'running', succeeded: 'done', failed: 'failed', unfinished: 'unfinished' }[status]
}

/** A time as the page shows it, in the browser's own time zone. */
export function shownTime(iso: string): string {
	return new Date(iso).toLocaleString()
}
