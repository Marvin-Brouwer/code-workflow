import { match } from '@rooted/components'
import type { RunRecord, RunRequest } from '../_shared/runs.mts'
import type { StepStatus } from './run-steps.mts'

/** What a run waits on, in a few words, such as `needs input`. Empty when it waits on nothing. */
export function waitsOn(pending: readonly RunRequest[]): string {
	const said = pending.map(({ kind }) =>
		match(kind, {
			input: 'needs input',
			login: 'needs login',
			wake: 'waits',
		}),
	)
	return [...new Set(said)].join(', ')
}

/** Whether a run waits on a person: an answer or a sign-in. */
export function needsSomeone(record: RunRecord): boolean {
	return record.pending.some(({ kind }) => kind === 'input' || kind === 'login')
}

/** The runs in the order the list shows them: those that need someone first, then the latest change first. */
export function inListOrder(records: readonly RunRecord[]): RunRecord[] {
	return records.toSorted(
		(first, second) => Number(needsSomeone(second)) - Number(needsSomeone(first)) || second.updatedAt.localeCompare(first.updatedAt),
	)
}

/** A step's status as the bar shows it. */
export function statusLabel(status: StepStatus): string {
	return match(status, {
		running: 'running',
		succeeded: 'done',
		failed: 'failed',
		interrupted: 'interrupted',
	})
}

/** A time as the page shows it, in the browser's own time zone. */
export function shownTime(iso: string): string {
	return new Date(iso).toLocaleString()
}
