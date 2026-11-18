import { component } from '@rooted/components'
import { z } from 'zod'
import { ProviderForm } from '../_forms/provider-form.mts'
import { ProviderKeyForm } from '../_forms/provider-key-form.mts'
import { read, send, type Answer } from '../_shared/api.mts'
import { ListedProvider, NoContent } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/** The model providers in the order models are looked up: add one, set a key, move one, remove one. */
export const ProvidersPage = component({
	name: 'providers-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', { classes: styles.section })
		const status = element('p', { role: 'alert' })

		const change = async (changing: Promise<Answer<unknown>>) => {
			const answer = await changing
			status.textContent = answer.ok ? '' : answer.error
			await show()
		}

		const row = (provider: ListedProvider, index: number, providers: readonly ListedProvider[]) => {
			const move = (by: number) => {
				const names = providers.map(({ name }) => name)
				names.splice(index, 1)
				names.splice(index + by, 0, provider.name)
				void change(send('PUT', '/settings/provider-order', { names }, NoContent, signal))
			}
			return element('tr', {
				children: [
					element('td', { textContent: String(index + 1) }),
					element('td', { textContent: provider.name }),
					element('td', { textContent: provider.kind }),
					element('td', { textContent: provider.baseUrl ?? '' }),
					element('td', { textContent: provider.hasKey ? 'set' : 'not set' }),
					element('td', {
						children: element('div', {
							classes: styles.actions,
							children: [
								element('button', {
									type: 'button',
									textContent: 'Up',
									disabled: index === 0,
									on: {
										click() {
											move(-1)
										},
									},
								}),
								element('button', {
									type: 'button',
									textContent: 'Down',
									disabled: index === providers.length - 1,
									on: {
										click() {
											move(1)
										},
									},
								}),
								element('details', {
									children: [
										element('summary', { textContent: 'Set key' }),
										create(ProviderKeyForm, { provider: provider.name, done: shown }),
									],
								}),
								element('details', {
									children: [
										element('summary', { textContent: 'Remove' }),
										element('button', {
											type: 'button',
											textContent: `Remove ${provider.name} and its key`,
											on: {
												click() {
													void change(send('DELETE', `/settings/providers/${encodeURIComponent(provider.name)}`, {}, NoContent, signal))
												},
											},
										}),
									],
								}),
							],
						}),
					}),
				],
			})
		}

		const view = (providers: Answer<ListedProvider[]>) => {
			if (!providers.ok) return element('p', { role: 'alert', textContent: providers.error })
			if (providers.value.length === 0) return element('p', { textContent: 'No providers yet. Agents need one that offers their model.' })
			return element('table', {
				children: [
					element('thead', {
						children: element('tr', {
							children: ['', 'Name', 'Kind', 'Base URL', 'Key', ''].map((heading) => element('th', { textContent: heading })),
						}),
					}),
					element('tbody', { children: providers.value.map(row) }),
				],
			})
		}

		const shown = () => {
			void show()
		}

		async function show(): Promise<void> {
			list.replaceChildren(view(await read('/settings/providers', z.array(ListedProvider), signal)))
		}

		append(
			create(SettingsMenu),
			element('h1', { textContent: 'Providers' }),
			element('p', { textContent: 'A model goes to the first provider that offers it.' }),
			list,
			status,
			element('section', {
				classes: styles.section,
				children: [element('h2', { textContent: 'Add a provider' }), create(ProviderForm, { done: shown })],
			}),
		)
		await show()
	},
})
