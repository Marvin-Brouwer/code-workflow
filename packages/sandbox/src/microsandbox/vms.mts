import { Sandbox as MicrosandboxSdkSandbox, Snapshot, type SandboxHandle } from 'microsandbox'
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
	for (const snapshot of await snapshotsOf(id)) {
		if (snapshot.name !== null) await Snapshot.remove(snapshot.name, { force: true })
	}
}
