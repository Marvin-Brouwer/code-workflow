import { ConnectorsRoute, CredentialsRoute, ProvidersRoute } from './_routes.mts'

/** The settings pages, in the order the menu and the settings page list them. */
export const settingsPages = [
	{
		route: ProvidersRoute,
		label: 'Providers',
		description: "the keys of the model providers the app's config declares.",
	},
	{
		route: CredentialsRoute,
		label: 'Credentials',
		description: 'tokens, webhook secrets and service settings; values never come back.',
	},
	{
		route: ConnectorsRoute,
		label: 'Connectors',
		description: 'the connectors the engine loads, and signing in to their services.',
	},
] as const
