import { Sandbox as MicrosandboxSdkSandbox, type SandboxHandle, type SnapshotHandle } from 'microsandbox'
import { snapshotsOf } from './snapshots.mts'

/**
 * Kills rather than stops: `stop()` waits for the processes in it, which may never exit. The
 * backend also uses it to remove a VM that was created after its create was aborted.
 */
export async function removeSandbox(sandbox: MicrosandboxSdkSandbox): Promise<void> {
	await sandbox.kill()
	await MicrosandboxSdkSandbox.remove(sandbox.name)
}

export async function allSandboxes(): Promise<SandboxHandle[]> {
	const handles: SandboxHandle[] = []
	let cursor: string | undefined
	do {
		const page = await MicrosandboxSdkSandbox.listWith((list) => (cursor === undefined ? list : list.cursor(cursor)))
		handles.push(...page.sandboxes)
		cursor = page.nextCursor
	} while (cursor !== undefined)
	return handles
}

/** The VM, if there is one, and every snapshot of it: what `destroy` and `remove` take away. */
export async function removeSandboxAndSnapshots(id: string): Promise<void> {
	const handle = (await allSandboxes()).find((candidate) => candidate.name === id)
	if (handle) {
		if (handle.status !== 'stopped' && handle.status !== 'crashed') await handle.kill()
		await handle.remove()
	}
	for (const snapshot of await snapshotsOf(id)) await removeSnapshot(snapshot, { force: true })
}

/**
 * Removes through the handle: a bare name only resolves inside the sandbox's own group. Forcing
 * the removal of a parent also removes its children, so a snapshot that is already gone is fine.
 */
export async function removeSnapshot(snapshot: SnapshotHandle, options: { readonly force?: boolean } = {}): Promise<void> {
	try {
		await snapshot.remove(options)
	} catch (error) {
		if (!isSnapshotNotFound(error)) throw error
	}
}

function isSnapshotNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.includes('SnapshotNotFound')
}
