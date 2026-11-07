import { Snapshot, type SnapshotHandle } from 'microsandbox'
import { isSandboxId, sandboxIdLength } from '../sandbox-id.mts'

/** A new name for a snapshot of this sandbox: the id and a time, so every pause gets its own. */
export function snapshotName(id: string): string {
	return `${id}-${Date.now().toString(36)}`
}

/** The sandbox a snapshot belongs to, or `undefined` for a snapshot this package didn't make. */
export function sandboxIdOfSnapshot(name: string | null): string | undefined {
	if (name?.charAt(sandboxIdLength) !== '-') return undefined
	const id = name.slice(0, sandboxIdLength)
	return isSandboxId(id) ? id : undefined
}

/** Every snapshot this package took, with the sandbox it belongs to. */
export async function meshFlowSnapshots(): Promise<{ readonly id: string; readonly snapshot: SnapshotHandle }[]> {
	const owned = []
	for (const snapshot of await Snapshot.list()) {
		const id = sandboxIdOfSnapshot(snapshot.name)
		if (id !== undefined) owned.push({ id, snapshot })
	}
	return owned
}

/** Every snapshot of one sandbox. */
export async function snapshotsOf(id: string): Promise<SnapshotHandle[]> {
	return (await meshFlowSnapshots()).filter((owned) => owned.id === id).map((owned) => owned.snapshot)
}
