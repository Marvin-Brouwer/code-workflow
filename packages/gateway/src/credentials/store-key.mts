import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { AsyncEntry } from '@napi-rs/keyring'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode } from '../errors.mts'
import { storeKeyBytes } from './sealed-file.mts'

/** Where the key the credential store is sealed with comes from. Made on first use. */
export interface StoreKey {
	/** Says where the key is, for the engine's log. */
	readonly where: string
	readonly read: (abortSignal: AbortSignal) => Promise<Buffer>
}

/** The service name the key has in the OS keychain. */
const keychainService = 'mesh-flow'

/**
 * The key in the OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on
 * Linux), under the `mesh-flow` service and `account`. Throws when there is no keychain to use.
 */
export function keychainKey(account: string): StoreKey {
	const entry = new AsyncEntry(keychainService, account)
	return {
		where: `the OS keychain (${keychainService}/${account})`,
		async read(abortSignal) {
			const known = await entry.getPassword(abortSignal)
			if (known !== null) return toKey(Buffer.from(known, 'base64'), 'the OS keychain')
			const made = randomBytes(storeKeyBytes)
			await entry.setPassword(made.toString('base64'), abortSignal)
			return made
		},
	}
}

/** The key in a file only its owner can read. For machines without a keychain, such as a headless Linux or WSL. */
export function keyFile(file: string): StoreKey {
	return {
		where: file,
		async read(abortSignal) {
			const known = await readFile(file, { signal: abortSignal }).catch((error: unknown) => {
				if (hasErrorCode(error, 'ENOENT')) return undefined
				throw error
			})
			if (known !== undefined) return toKey(known, file)
			const made = randomBytes(storeKeyBytes)
			await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
			await writeFileAtomic(file, made, { mode: 0o600 })
			return made
		},
	}
}

/**
 * The key a gateway in `home` uses: the key file when there is one, otherwise the OS keychain,
 * otherwise a new key file. Once a key is made, it stays where it was made, so a keychain that is
 * locked later fails loudly instead of quietly starting a new store.
 */
export async function defaultStoreKey(home: string, abortSignal: AbortSignal): Promise<StoreKey> {
	const file = keyFile(path.join(home, 'store.key'))
	const fileExists = await readFile(file.where, { signal: abortSignal }).then(
		() => true,
		() => false,
	)
	if (fileExists) return file
	const keychain = keychainKey(home)
	try {
		await keychain.read(abortSignal)
		return keychain
	} catch (error) {
		abortSignal.throwIfAborted()
		if (error instanceof KeyLengthError) throw error
		return file
	}
}

class KeyLengthError extends Error {
	override readonly name = 'KeyLengthError'
}

function toKey(bytes: Buffer, where: string): Buffer {
	if (bytes.length !== storeKeyBytes)
		throw new KeyLengthError(`The credential store's key in ${where} isn't ${String(storeKeyBytes)} bytes.`)
	return bytes
}
