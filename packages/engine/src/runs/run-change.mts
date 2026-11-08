import type { RunRecord } from './run-record.mts'

/** Fields to change on a record. A field set to `undefined` is left out when the record is saved. */
export type RunChange = Partial<RunRecord>

/** The record with `change` applied and `updatedAt` set. */
export function applyRunChange(record: RunRecord, change: RunChange, updatedAt: Date): RunRecord {
	return { ...record, ...change, updatedAt: updatedAt.toISOString() }
}
