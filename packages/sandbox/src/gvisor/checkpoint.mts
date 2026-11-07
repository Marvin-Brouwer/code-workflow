import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

const finishedName = /^[0-9a-z]+$/

/** A new checkpoint name: the time, so every pause of a sandbox gets its own directory. */
export function newCheckpointName(): string {
	return Date.now().toString(36)
}

/** Whether `name` is a finished checkpoint. One in progress ends in `.partial`. */
export function isCheckpointName(name: string): boolean {
	return finishedName.test(name)
}

/** Where a checkpoint is written until it's finished and renamed to its name. */
export function partialCheckpoint(checkpoints: string, name: string): string {
	return path.join(checkpoints, `${name}.partial`)
}

/** Whether a sandbox's checkpoint directory holds a finished checkpoint. */
export async function hasCheckpoint(checkpoints: string): Promise<boolean> {
	if (!existsSync(checkpoints)) return false
	return (await readdir(checkpoints)).some(isCheckpointName)
}

/** Earlier pauses. Nothing reads them once the sandbox that came from them has stopped. */
export async function removeEarlierCheckpoints(checkpoints: string, keep: string): Promise<void> {
	for (const entry of await readdir(checkpoints)) {
		if (entry !== keep) await rm(path.join(checkpoints, entry), { recursive: true, force: true })
	}
}
