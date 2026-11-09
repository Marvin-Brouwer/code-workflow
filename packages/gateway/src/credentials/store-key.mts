import { randomBytes, randomUUID } from 'node:crypto'
import { access, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AsyncEntry } from '@napi-rs/keyring'
import { hasErrorCode, messageOf } from '../errors.mts'
import { credentialsFileName } from './credential-store.mts'
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
			// Written whole next to it, then linked in place only when there is none yet: when two
			// processes make one at once, both use the first, and a crash never leaves half a key.
			const partialFile = `${file}.${randomUUID()}.partial`
			try {
				await writeFile(partialFile, made, { mode: 0o600, signal: abortSignal })
				const linked = await link(partialFile, file).then(
					() => true,
					async (error: unknown) => {
						if (hasErrorCode(error, 'EEXIST')) return false
						// A file system without hard links: made in place, which is still only when there is none.
						if (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'ENOTSUP')) throw error
						return writeFile(file, made, { mode: 0o600, flag: 'wx', signal: abortSignal }).then(
							() => true,
							(fallback: unknown) => {
								if (hasErrorCode(fallback, 'EEXIST')) return false
								throw fallback
							},
						)
					},
				)
				return linked ? made : toKey(await readFile(file, { signal: abortSignal }), file)
			} finally {
				await rm(partialFile, { force: true })
			}
		},
	}
}

/** Where {@link defaultStoreKey} may look for a key. */
export interface DefaultStoreKeyOptions {
	/** Whether to use the OS keychain. Off, for tests that mustn't touch the user's keychain. Default: on. */
	readonly keychain?: boolean
	/** The keychain's key for an account. {@link keychainKey} by default; a test passes its own. */
	readonly keychainKey?: (account: string) => StoreKey
}

/**
 * The key a gateway in `home` uses: the key file when there is one, otherwise the OS keychain,
 * otherwise a new key file. Once a key is made, it stays where it was made: when the keychain fails
 * and the credentials are sealed already, this throws instead of starting a key file, which would
 * never open them.
 */
export async function defaultStoreKey(home: string, abortSignal: AbortSignal, options: DefaultStoreKeyOptions = {}): Promise<StoreKey> {
	const file = keyFile(path.join(home, 'store.key'))
	if ((await exists(file.where)) || options.keychain === false) return file
	const keychain = (options.keychainKey ?? keychainKey)(home)
	try {
		await keychain.read(abortSignal)
		return keychain
	} catch (error) {
		abortSignal.throwIfAborted()
		if (error instanceof KeyLengthError) throw error
		if (await exists(path.join(home, credentialsFileName)))
			throw new Error(`The credentials in ${home} are sealed with a key in the OS keychain, which can't be read: ${messageOf(error)}`, {
				cause: error,
			})
		return file
	}
}

/** A key that is there but isn't a key: never replaced by a new one, since the store would be lost. */
class KeyLengthError extends Error {
	override readonly name = 'KeyLengthError'
}

function toKey(bytes: Buffer, where: string): Buffer {
	if (bytes.length !== storeKeyBytes)
		throw new KeyLengthError(`The credential store's key in ${where} isn't ${String(storeKeyBytes)} bytes.`)
	return bytes
}

/** Whether there is a file at `file`. */
async function exists(file: string): Promise<boolean> {
	return access(file).then(
		() => true,
		() => false,
	)
}
