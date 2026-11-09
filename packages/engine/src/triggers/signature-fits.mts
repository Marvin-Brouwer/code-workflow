import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SignatureScheme } from '@mesh-flow/protocol'

/**
 * Whether a delivery is signed with `secret` the way `scheme` says. Compares in constant time, so
 * the time an answer takes says nothing about the secret.
 */
export function signatureFits(scheme: SignatureScheme, secret: string, headers: Headers, body: Uint8Array): boolean {
	const given = headers.get(scheme.header)
	if (given === null) return false
	if (scheme.scheme === 'secret-header') return equalInConstantTime(given, secret)
	if (!given.startsWith(scheme.prefix)) return false
	const expected = createHmac('sha256', secret).update(body).digest('hex')
	return equalInConstantTime(given.slice(scheme.prefix.length).toLowerCase(), expected)
}

function equalInConstantTime(given: string, expected: string): boolean {
	const left = Buffer.from(given)
	const right = Buffer.from(expected)
	return left.length === right.length && timingSafeEqual(left, right)
}
