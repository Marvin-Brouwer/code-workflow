import { isSandboxId } from '../sandbox-id.mts'

const idLength = 'mesh-flow-'.length + 12

/** A new name for a snapshot of this sandbox: the id and a time, so every pause gets its own. */
export function snapshotName(id: string): string {
	return `${id}-${Date.now().toString(36)}`
}

/** The sandbox a snapshot belongs to, or `undefined` for a snapshot this package didn't make. */
export function sandboxIdOfSnapshot(name: string | null): string | undefined {
	if (name?.charAt(idLength) !== '-') return undefined
	const id = name.slice(0, idLength)
	return isSandboxId(id) ? id : undefined
}
