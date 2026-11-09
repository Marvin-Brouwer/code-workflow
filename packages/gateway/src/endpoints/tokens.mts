import { createHash, randomBytes } from 'node:crypto'

/** Random bytes in a token: as much as a key, so guessing one is out of the question. */
const tokenBytes = 32

/** A new single-use token. URL-safe, so it fits `EndpointToken`. */
export function newToken(): string {
	return randomBytes(tokenBytes).toString('base64url')
}

/** What the gateway keeps of a token: its hash, so its own files never hold a token that works. */
export function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

/** How many random bytes a loop endpoint's id has: enough that two loops never share one. */
const loopIdBytes = 9

/** A new id for a loop's endpoint. */
export function newLoopEndpointId(): string {
	return `loop-${randomBytes(loopIdBytes).toString('base64url')}`
}
