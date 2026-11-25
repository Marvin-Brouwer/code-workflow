import { choice, component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ListedProvider, providerCredential, providerKeyText } from '../_shared/settings.mts'
import { CredentialsRoute } from './_routes.mts'
import { ProviderModels } from './provider-models.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/**
 * The model providers the app's config declares, in the order models are looked up, with the models
 * each offers its key. They come from git; their keys are set on the credentials page.
 */
export const ProvidersPage = component({
	name: 'providers-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', {
			classes: styles.section,
		})
		const keyLink = (provider: ListedProvider) =>
			create(Link, {
				href: `${href.for(CredentialsRoute).href}#${providerCredential(provider.name)}`,
				children: choice(provider.hasKey, 'Change key', 'Set key'),
			})

		const models = (provider: ListedProvider) => {
			if (!provider.hasKey)
				return element('span', {
					classes: styles.muted,
					textContent: 'Listed once it has a key.',
				})
			return create(ProviderModels, {
				provider: provider.name,
			})
		}

		const row = (provider: ListedProvider, index: number) =>
			element('tr', {
				children: [
					element('td', {
						textContent: String(index + 1),
					}),
					element('td', {
						textContent: provider.name,
					}),
					element('td', {
						textContent: provider.kind,
					}),
					element('td', {
						textContent: provider.baseUrl ?? '',
					}),
					element('td', {
						children: element('div', {
							classes: styles.actions,
							children: [providerKeyText(provider), keyLink(provider)],
						}),
					}),
					element('td', {
						children: models(provider),
					}),
				],
			})

		const readProviders = () => read('/settings/providers', z.array(ListedProvider), signal)

		const view = (providers: Answer<ListedProvider[]>) => {
			if (!providers.ok) return errorText(element, providers.error)
			if (providers.value.length === 0)
				return element('p', {
					textContent: "The app's config declares no providers. Add them to modelProviders in defineMeshFlow.",
				})
			return create(Table, {
				headings: ['', 'Name', 'Kind', 'Base URL', 'Key', 'Models'],
				rows: providers.value.map(row),
			})
		}

		async function show(): Promise<void> {
			list.replaceChildren(view(await readProviders()))
		}

		append(
			create(SettingsMenu),
			element('h1', {
				textContent: 'Providers',
			}),
			element('p', {
				textContent:
					"The app's config declares these, in git. A model goes to the first one that offers it and has a key. Keys are sealed on this machine and never come back.",
			}),
			list,
		)
		await show()
	},
})
