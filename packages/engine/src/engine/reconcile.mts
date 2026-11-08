import type { SandboxBackend } from '@mesh-flow/sandbox'
import { messageOf } from '../errors.mts'
import type { RunChange } from '../runs/run-change.mts'
import type { RunId } from '../runs/run-id.mts'
import { finishedStatuses, type RunRecord } from '../runs/run-record.mts'

/** What reconciliation did: the sandboxes it removed, the ones it couldn't, and the changes to make to records. */
export interface Reconciliation {
	readonly removed: readonly string[]
	/** Sandboxes that couldn't be removed, and why. The next start tries again. */
	readonly problems: readonly string[]
	readonly changes: ReadonlyMap<RunId, RunChange>
}

/**
 * Brings the backend and the run records back in line after the engine stopped, cleanly or not.
 *
 * - A sandbox no unfinished run owns is removed.
 * - A paused run whose paused sandbox is still there stays paused; `resume` picks it up.
 * - Anything else that was in progress is gone or can't be picked up again: a running sandbox
 *   has nobody polling its mailbox and can't be attached to, so it's removed, and the run becomes
 *   restartable.
 *
 * Runs whose sandbox lives on another backend are left alone. Nothing is resumed automatically. A
 * sandbox that can't be removed doesn't stop the start: it's reported, and the next start tries again.
 */
export async function reconcile(records: readonly RunRecord[], backend: SandboxBackend, signal: AbortSignal): Promise<Reconciliation> {
	const held = new Map((await backend.list(signal)).map((sandbox) => [sandbox.id, sandbox]))
	const unfinished = records.filter((record) => !finishedStatuses.has(record.status))
	const ours = unfinished.filter((record) => record.sandbox === undefined || record.sandbox.backend === backend.name)

	const kept = new Set<string>()
	for (const record of ours) {
		const sandbox = record.sandbox && held.get(record.sandbox.id)
		if (record.status === 'paused' && record.paused !== undefined && sandbox?.state === 'paused') kept.add(sandbox.id)
	}

	const removed: string[] = []
	const problems: string[] = []
	for (const id of held.keys()) {
		if (kept.has(id)) continue
		try {
			await backend.remove(id, signal)
			removed.push(id)
		} catch (error) {
			signal.throwIfAborted()
			problems.push(`Removing sandbox ${id} failed: ${messageOf(error)}`)
		}
	}

	const changes = new Map<RunId, RunChange>()
	for (const record of ours) {
		if (record.sandbox && kept.has(record.sandbox.id)) continue
		if (record.status === 'restartable') continue
		changes.set(record.id, {
			status: 'restartable',
			sandbox: undefined,
			paused: undefined,
			pending: [],
			error: whyRestartable(record),
		})
	}
	return { removed, problems, changes }
}

/** The error a run gets when reconciling makes it restartable. */
function whyRestartable(record: RunRecord): string {
	if (record.status === 'paused') return 'Its paused sandbox is gone.'
	if (record.status === 'starting') return 'The engine stopped while the run was starting.'
	return 'The engine stopped without pausing its sandbox.'
}
