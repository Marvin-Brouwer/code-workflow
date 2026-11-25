import { component } from '@rooted/components'
import { z } from 'zod'
import { CredentialForm } from '../_forms/credential-form.mts'
import { Table } from '../_layout/table.mts'
import { ReplaceCredentialForm } from '../_forms/replace-credential-form.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/** The credentials by name, never their values: set one, generate a webhook secret, replace or clear one. */
export const CredentialsPage = component({
	name: 'credentials-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', {
			classes: styles.section,
		})

		const row = (name: string) =>
			element('tr', {
				children: [
					element('td', {
						children: element('code', {
							textContent: name,
						}),
					}),
					element('td', {
						children: create(ReplaceCredentialForm, {
							name,
							done() {
								void show()
							},
						}),
					}),
				],
			})

		const view = (names: Answer<string[]>) => {
			if (!names.ok) return errorText(element, names.error)
			if (names.value.length === 0)
				return element('p', {
					textContent: 'No credentials yet.',
				})
			return create(Table, {
				headings: ['Name', ''],
				rows: names.value.toSorted().map(row),
			})
		}

		async function show(): Promise<void> {
			list.replaceChildren(view(await read('/settings/credentials', z.array(z.string()), signal)))
		}

		append(
			create(SettingsMenu),
			element('h1', {
				textContent: 'Credentials',
			}),
			element('p', {
				textContent:
					'Tokens and settings connectors look up, such as github/token, and webhook secrets, as webhook/<webhook>. Sealed on this machine; a value never comes back.',
			}),
			list,
			element('section', {
				classes: styles.section,
				children: [
					element('h2', {
						textContent: 'Set a credential',
					}),
					element('p', {
						classes: styles.muted,
						textContent:
							"For a webhook secret, Generate makes one: copy it into the webhook's settings on the other side before you set it.",
					}),
					create(CredentialForm, {
						done() {
							void show()
						},
					}),
				],
			}),
		)
		await show()
	},
})
