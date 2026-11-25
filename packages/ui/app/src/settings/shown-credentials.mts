import { choice } from '@rooted/components'
import { credentialSetText, providerCredential, providerKeyText, providerOfCredential, type ListedProvider } from '../_shared/settings.mts'

/** A credential on the page: one that's stored, or the key of a provider the app's config declares. */
export interface ShownCredential {
	/** Its name in the credential store, which is also its row's id. */
	readonly name: string
	/** Whether it's set, and for a provider's key, whether it's used. */
	readonly stateText: string
	/** Whether the credential store holds a value, so it can be replaced and cleared. */
	readonly stored: boolean
	/** Whether a value can be sent: a provider's key only for a provider the config declares. */
	readonly settable: boolean
}

/** What a stored provider key shows when no provider the config declares, as far as the page knows, is its provider. */
const unknownProviderText = 'set, for no provider the config declares'

/**
 * The stored credentials, and the keys of the declared providers, set or not, by name. Without the
 * declared providers, a stored provider key can only be cleared.
 */
export function shownCredentials(names: readonly string[], providers: readonly ListedProvider[]): ShownCredential[] {
	const keys = providers.map((provider) => {
		const name = providerCredential(provider.name)
		return {
			name,
			stateText: providerKeyText(provider),
			stored: names.includes(name),
			settable: true,
		}
	})
	const others = names
		.filter((name) => !keys.some((key) => key.name === name))
		.map((name) => {
			const settable = providerOfCredential(name) === undefined
			return {
				name,
				stateText: choice(settable, credentialSetText, unknownProviderText),
				stored: true,
				settable,
			}
		})
	return [...keys, ...others].toSorted((left, right) => left.name.localeCompare(right.name))
}

/** What a row shows: a row whose credential shows the same is kept as it is, with what's typed in it. */
export function rowKey({ name, stateText, stored, settable }: ShownCredential): string {
	return JSON.stringify([name, stateText, stored, settable])
}
