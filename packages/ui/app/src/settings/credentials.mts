import { component } from '@rooted/components'
import { z } from 'zod'
import { CredentialForm } from '../_forms/credential-form.mts'
import { ReplaceCredentialForm } from '../_forms/replace-credential-form.mts'
import { Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ListedProvider, providerCredential, providerKeyText } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/** A credential on the page: one that's stored, or the key of a provider the app's config declares. */
interface ShownCredential {
	readonly name: string
	/** Whether it's set, and for a provider's key, whether it's used. */
	readonly state: string
	readonly stored: boolean
}

/** The stored credentials, and the keys of the declared providers, set or not, by name. */
function shownCredentials(names: readonly string[], providers: readonly ListedProvider[]): ShownCredential[] {
	const keys = providers.map((provider) => {
		const name = providerCredential(provider.name)
		return {
			name,
			state: providerKeyText(provider),
			stored: names.includes(name),
		}
	})
	const others = names
		.filter((name) => !keys.some((key) => key.name === name))
		.map((name) => ({
			name,
			state: 'set',
			stored: true,
		}))
	return [...keys, ...others].toSorted((left, right) => left.name.localeCompare(right.name))
}

/**
 * The credentials by name, never their values, and the keys of the app's providers: set, replace
 * or clear one in its row, or set another one, such as a generated webhook secret. A link to
 * `#<name>` puts the cursor in that credential's row.
 */
export const CredentialsPage = component({
	name: 'credentials-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', {
			classes: styles.section,
		})

		const row = ({ name, state, stored }: ShownCredential) =>
			element('tr', {
				id: name,
				children: [
					element('td', {
						children: element('code', {
							textContent: name,
						}),
					}),
					element('td', {
						textContent: state,
					}),
					element('td', {
						children: create(ReplaceCredentialForm, {
							name,
							stored,
							done() {
								void show()
							},
						}),
					}),
				],
			})

		const view = (names: Answer<string[]>, providers: Answer<ListedProvider[]>) => {
			if (!names.ok) return errorText(element, names.error)
			// Without the running engine there are no declared providers: the stored credentials still show.
			const shown = shownCredentials(names.value, providers.ok ? providers.value : [])
			if (shown.length === 0)
				return element('p', {
					textContent: 'No credentials yet.',
				})
			return create(Table, {
				headings: ['Name', 'State', ''],
				rows: shown.map(row),
			})
		}

		async function show(): Promise<void> {
			const [names, providers] = await Promise.all([
				read('/settings/credentials', z.array(z.string()), signal),
				read('/settings/providers', z.array(ListedProvider), signal),
			])
			list.replaceChildren(view(names, providers))
		}

		/** Puts the cursor in the row the address links to, such as `#provider/anthropic`. */
		const focusLinked = () => {
			const linked = decodeURIComponent(location.hash.slice(1))
			if (linked === '') return
			const linkedRow = [...list.querySelectorAll('tr')].find((tableRow) => tableRow.id === linked)
			linkedRow?.querySelector('input')?.focus()
		}

		append(
			create(SettingsMenu),
			element('h1', {
				textContent: 'Credentials',
			}),
			element('p', {
				textContent:
					"Tokens and settings connectors look up, such as github/token, webhook secrets, as webhook/<webhook>, and the keys of the app's providers, as provider/<name>. Sealed on this machine; a value never comes back.",
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
		focusLinked()
	},
})
