import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { readTextIfExists } from '../files/read-text-if-exists.mts'
import { withFileLock } from '../files/with-file-lock.mts'
import { seal, unseal } from './sealed-file.mts'
import type { StoreKey } from './store-key.mts'

/**
 * Names a credential, such as `provider/anthropic` or `webhook/team/fix-issue`: letters, digits and
 * `_ . / -`, up to 128.
 */
export const CredentialName = z.string().regex(/^[\w./-]{1,128}$/, 'Use 1 to 128 letters, digits, _, ., / or -.')
export type CredentialName = z.infer<typeof CredentialName>

/** Reads credentials. What host tools get: they never write. */
export interface CredentialReader {
	/** The secret with this name, or `undefined` when none is set. */
	readonly get: (name: string, abortSignal: AbortSignal) => Promise<string | undefined>
}

/**
 * The gateway's credentials, sealed in one file on the host. Never in the sandbox, never in git,
 * never in a `.env` file. Every read opens the file again, so a secret set with the CLI counts at
 * once in a running engine.
 */
export interface CredentialStore extends CredentialReader {
	readonly set: (name: string, secret: string, abortSignal: AbortSignal) => Promise<void>
	/** Removes a credential. Resolves `false` when there was none. */
	readonly remove: (name: string, abortSignal: AbortSignal) => Promise<boolean>
	/** The names of every credential, sorted. Never the secrets. */
	readonly names: (abortSignal: AbortSignal) => Promise<string[]>
}

const Secrets = z.record(z.string(), z.string())

/**
 * Opens the credential store in `file`, sealed with `key` (AES-256-GCM). The file is made on the
 * first write, readable by its owner only. Writes from several processes, such as the engine and
 * the CLI, take turns.
 *
 * ```ts
 * const store = openCredentialStore(path.join(home, 'credentials.json'), await defaultStoreKey(home, abortSignal))
 * await store.set('provider/anthropic', apiKey, abortSignal)
 * ```
 */
export function openCredentialStore(file: string, key: StoreKey): CredentialStore {
	const read = async (abortSignal: AbortSignal): Promise<Record<string, string>> => {
		const text = await readTextIfExists(file, abortSignal)
		if (text === undefined) return {}
		return Secrets.parse(JSON.parse(unseal(text, await key.read(abortSignal))))
	}
	const change = (abortSignal: AbortSignal, edit: (secrets: Record<string, string>) => boolean): Promise<boolean> =>
		withFileLock(file, async () => {
			const secrets = await read(abortSignal)
			if (!edit(secrets)) return false
			abortSignal.throwIfAborted()
			await writeFileAtomic(file, seal(JSON.stringify(secrets), await key.read(abortSignal)), { mode: 0o600 })
			return true
		})
	return Object.freeze<CredentialStore>({
		get: async (name, abortSignal) => (await read(abortSignal))[CredentialName.parse(name)],
		async set(name, secret, abortSignal) {
			const checked = CredentialName.parse(name)
			if (secret.length === 0) throw new Error(`The secret for ${checked} is empty.`)
			await change(abortSignal, (secrets) => {
				secrets[checked] = secret
				return true
			})
		},
		remove: (name, abortSignal) => {
			const checked = CredentialName.parse(name)
			return change(abortSignal, (secrets) => {
				if (!(checked in secrets)) return false
				delete secrets[checked]
				return true
			})
		},
		names: async (abortSignal) => Object.keys(await read(abortSignal)).toSorted(),
	})
}
