/** How many random bytes a generated secret has: as many as `mesh-flow credential set --generate`. */
const generatedSecretBytes = 32

/** Random bytes as hex: a webhook secret or anything else nobody has to type. */
export function randomSecret(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(generatedSecretBytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
