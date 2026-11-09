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

/** A new id for a loop's endpoint. */
export function newLoopEndpointId(): string {
	return `loop-${randomBytes(9).toString('base64url')}`
}
