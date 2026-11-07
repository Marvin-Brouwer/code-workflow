import { randomBytes } from 'node:crypto'

/** How `list` tells mesh-flow's sandboxes from anything else on a backend. */
export const sandboxIdPrefix = 'mesh-flow-'
const randomHexLength = 12

/** Every sandbox id is exactly this long. */
export const sandboxIdLength = sandboxIdPrefix.length + randomHexLength

const pattern = new RegExp(`^${sandboxIdPrefix}[0-9a-f]{${String(randomHexLength)}}$`)

export function newSandboxId(): string {
	return `${sandboxIdPrefix}${randomBytes(randomHexLength / 2).toString('hex')}`
}

export function isSandboxId(id: string): boolean {
	return pattern.test(id)
}

/** Ids end up in paths and runsc arguments, so anything else is refused. */
export function assertSandboxId(id: string): void {
	if (!isSandboxId(id)) throw new Error(`'${id}' isn't a mesh-flow sandbox id.`)
}
