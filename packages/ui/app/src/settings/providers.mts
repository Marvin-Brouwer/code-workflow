import { choice, component, optional } from '@rooted/components'
import { z } from 'zod'
import { ProviderKeyForm } from '../_forms/provider-key-form.mts'
import { Table } from '../_layout/table.mts'
import { read, send, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ListedProvider, NoContent } from '../_shared/settings.mts'
import { ConfirmButton } from './confirm-button.mts'
import { ProviderModels } from './provider-models.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/**
 * The model providers the app's config declares, in the order models are looked up. They come from
 * git, so only their keys are set here.
 */
export const ProvidersPage = component({
	name: 'providers-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', {
			classes: styles.section,
		})
		const status = element('p', {
			role: 'alert',
		})

		const removeKey = async (name: string) => {
			const answer = await send('DELETE', `/settings/providers/${encodeURIComponent(name)}/key`, {}, NoContent, signal)
			status.textContent = answer.ok ? '' : answer.error
			await show()
		}

		const keyActions = (provider: ListedProvider) =>
			element('div', {
				classes: styles.actions,
				children: [
					element('details', {
						children: [
							element('summary', {
								textContent: 'Set key',
							}),
							create(ProviderKeyForm, {
								provider: provider.name,
								done() {
									void show()
								},
							}),
						],
					}),
					optional(
						provider.hasKey,
						create(ProviderModels, {
							provider: provider.name,
						}),
					),
					optional(
						provider.hasKey,
						create(ConfirmButton, {
							summary: 'Remove key',
							label: `Remove the key of ${provider.name}`,
							confirmed() {
								void removeKey(provider.name)
							},
						}),
					),
				],
			})

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
						textContent: choice(provider.hasKey, 'set', 'not set'),
					}),
					element('td', {
						children: keyActions(provider),
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
				headings: ['', 'Name', 'Kind', 'Base URL', 'Key', ''],
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
			status,
		)
		await show()
	},
})
