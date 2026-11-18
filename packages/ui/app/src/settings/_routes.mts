import { route } from '@rooted/router/routes'

/** The settings: providers and their keys, credentials, and connectors with their sign-ins. */
export const SettingsRoute = route`/settings/`({
	async resolve({ create }) {
		const { SettingsPage } = await import('./settings.mts')
		return create(SettingsPage)
	},
})

export const ProvidersRoute = route`/${SettingsRoute}/providers/`({
	async resolve({ create }) {
		const { ProvidersPage } = await import('./providers.mts')
		return create(ProvidersPage)
	},
})

export const CredentialsRoute = route`/${SettingsRoute}/credentials/`({
	async resolve({ create }) {
		const { CredentialsPage } = await import('./credentials.mts')
		return create(CredentialsPage)
	},
})

export const ConnectorsRoute = route`/${SettingsRoute}/connectors/`({
	async resolve({ create }) {
		const { ConnectorsPage } = await import('./connectors.mts')
		return create(ConnectorsPage)
	},
})
