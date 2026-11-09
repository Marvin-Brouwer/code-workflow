import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** The cipher the store is sealed with: AES-256 in GCM, so a changed file fails to open instead of giving garbage. */
const cipher = 'aes-256-gcm'

/** The length of a store key in bytes. */
export const storeKeyBytes = 32

/** GCM's recommended nonce length. A new one for every write. */
const nonceBytes = 12

/** What the store's file holds: the sealed secrets, with what it takes to open them besides the key. */
const SealedFile = z.object({
	version: z.literal(1),
	nonce: z.base64(),
	tag: z.base64(),
	sealed: z.base64(),
})

/** Seals `plaintext` with `key`, as the text of the store's file. */
export function seal(plaintext: string, key: Buffer): string {
	const nonce = randomBytes(nonceBytes)
	const sealing = createCipheriv(cipher, key, nonce)
	const sealed = Buffer.concat([sealing.update(plaintext, 'utf8'), sealing.final()])
	const file: z.infer<typeof SealedFile> = {
		version: 1,
		nonce: nonce.toString('base64'),
		tag: sealing.getAuthTag().toString('base64'),
		sealed: sealed.toString('base64'),
	}
	return `${JSON.stringify(file, null, '\t')}\n`
}

/** Opens the text of the store's file with `key`. Throws when the key is wrong or the file was changed. */
export function unseal(text: string, key: Buffer): string {
	const file = SealedFile.parse(JSON.parse(text))
	const opening = createDecipheriv(cipher, key, Buffer.from(file.nonce, 'base64'))
	opening.setAuthTag(Buffer.from(file.tag, 'base64'))
	try {
		return Buffer.concat([opening.update(Buffer.from(file.sealed, 'base64')), opening.final()]).toString('utf8')
	} catch (error) {
		throw new Error("The credential store doesn't open with this key: the key changed, or the file did.", { cause: error })
	}
}
