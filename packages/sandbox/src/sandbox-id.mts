import { randomBytes } from 'node:crypto'

const pattern = /^mesh-flow-[0-9a-f]{12}$/

/** A new sandbox id. The prefix is how `list` tells mesh-flow's sandboxes from anything else. */
export function newSandboxId(): string {
	return `mesh-flow-${randomBytes(6).toString('hex')}`
}

export function isSandboxId(id: string): boolean {
	return pattern.test(id)
}

/** Ids end up in paths and runsc arguments, so anything else is refused. */
export function assertSandboxId(id: string): void {
	if (!isSandboxId(id)) throw new Error(`'${id}' isn't a mesh-flow sandbox id.`)
}
