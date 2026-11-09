import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'

/** Names a provider the user added, such as `anthropic` or `work-openrouter`. */
export const ProviderName = z.string().regex(/^[a-z0-9][\w-]{0,63}$/, 'Use 1 to 64 lowercase letters, digits, _ or -.')

/**
 * Who a provider belongs to. Only `user` for now; team providers fit in later without changing how
 * they are stored.
 */
export const ProviderOwner = z.enum(['user'])

/** One model provider the user added. Its API key is in the credential store, under {@link providerCredential}. */
export const ProviderSetting = z.object({
	name: ProviderName,
	/** The pi-ai provider it is, such as `anthropic`, `openai` or `openrouter`: its API, its base URL and its models. */
	kind: z.string().min(1),
	/** Overrides the kind's base URL, for a proxy or a compatible server. */
	baseUrl: z.url().optional(),
	owner: ProviderOwner.default('user'),
})
export type ProviderSetting = z.infer<typeof ProviderSetting>

const ProviderSettingsFile = z.object({ providers: z.array(ProviderSetting) })

/** The name a provider's API key has in the credential store. */
export function providerCredential(name: string): string {
	return `provider/${name}`
}

/**
 * The user's model providers, in order: a model id goes to the first one that offers it. No secrets:
 * those are in the credential store. Read again on every use, so a change with the CLI counts at once.
 */
export interface ProviderSettings {
	readonly list: (abortSignal: AbortSignal) => Promise<ProviderSetting[]>
	/** Adds a provider at the end, or replaces the one with its name where it is. */
	readonly put: (provider: z.input<typeof ProviderSetting>, abortSignal: AbortSignal) => Promise<void>
	/** Removes a provider. Resolves `false` when there was none. */
	readonly remove: (name: string, abortSignal: AbortSignal) => Promise<boolean>
	/** Puts the providers in this order. Every provider has to be named once. */
	readonly order: (names: readonly string[], abortSignal: AbortSignal) => Promise<void>
}

const lockRetries = { retries: 20, minTimeout: 25, maxTimeout: 250 }

/** The provider settings kept in `file`. */
export function openProviderSettings(file: string): ProviderSettings {
	const list = async (abortSignal: AbortSignal): Promise<ProviderSetting[]> => {
		const text = await readFile(file, { encoding: 'utf8', signal: abortSignal }).catch((error: unknown) => {
			if (hasErrorCode(error, 'ENOENT')) return undefined
			throw error
		})
		return text === undefined ? [] : ProviderSettingsFile.parse(JSON.parse(text)).providers
	}
	const change = async (abortSignal: AbortSignal, edit: (providers: ProviderSetting[]) => ProviderSetting[] | undefined) => {
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
		const release = await lockfile.lock(path.dirname(file), { lockfilePath: `${file}.lock`, retries: lockRetries })
		try {
			const next = edit(await list(abortSignal))
			if (next === undefined) return false
			abortSignal.throwIfAborted()
			await writeFileAtomic(file, `${JSON.stringify({ providers: next }, null, '\t')}\n`, { mode: 0o600 })
			return true
		} finally {
			await release()
		}
	}
	return Object.freeze<ProviderSettings>({
		list,
		async put(provider, abortSignal) {
			const checked = ProviderSetting.parse(provider)
			await change(abortSignal, (providers) => {
				const at = providers.findIndex((known) => known.name === checked.name)
				return at === -1 ? [...providers, checked] : providers.with(at, checked)
			})
		},
		remove: (name, abortSignal) =>
			change(abortSignal, (providers) => {
				const rest = providers.filter((known) => known.name !== name)
				return rest.length === providers.length ? undefined : rest
			}),
		async order(names, abortSignal) {
			await change(abortSignal, (providers) => {
				const known = new Set(providers.map((provider) => provider.name))
				const given = new Set(names)
				if (given.size !== names.length || given.size !== known.size || ![...given].every((name) => known.has(name))) {
					throw new Error(`Name every provider once: ${[...known].join(', ') || 'there are none'}.`)
				}
				return names.map((name) => providers.find((provider) => provider.name === name)).filter((provider) => provider !== undefined)
			})
		},
	})
}
