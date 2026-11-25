import { choice, component } from '@rooted/components'
import { z } from 'zod'
import { CredentialForm } from '../_forms/credential-form.mts'
import { CredentialRowForm } from '../_forms/credential-row-form.mts'
import { keepRows, Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ListedProvider, providerCredential, providerKeyText, providerOfCredential, setText } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/** A credential on the page: one that's stored, or the key of a provider the app's config declares. */
interface ShownCredential {
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
function shownCredentials(names: readonly string[], providers: readonly ListedProvider[]): ShownCredential[] {
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
				stateText: choice(settable, setText, unknownProviderText),
				stored: true,
				settable,
			}
		})
	return [...keys, ...others].toSorted((left, right) => left.name.localeCompare(right.name))
}

/** What a row shows: a row whose credential shows the same is kept as it is, with what's typed in it. */
function rowKey({ name, stateText, stored, settable }: ShownCredential): string {
	return JSON.stringify([name, stateText, stored, settable])
}

export const CredentialsPage = component({
	name: 'credentials-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const list = element('div', {
			classes: styles.section,
		})

		const newRow = ({ name, stateText, stored, settable }: ShownCredential) =>
			element('tr', {
				id: name,
				children: [
					element('td', {
						children: element('code', {
							textContent: name,
						}),
					}),
					element('td', {
						textContent: stateText,
					}),
					element('td', {
						children: create(CredentialRowForm, {
							name,
							stored,
							settable,
							done() {
								void show()
							},
						}),
					}),
				],
			})

		// The rows shown now, by what they show: a refresh keeps the rows that didn't change in place, so a
		// row being typed in or sent from isn't rebuilt, and its request isn't aborted, when another one is done.
		let shownRows = new Map<string, HTMLElement>()
		const rowOf = (credential: ShownCredential) => shownRows.get(rowKey(credential)) ?? newRow(credential)
		const body = element('tbody')
		const table = create(Table, {
			headings: ['Name', 'State', ''],
			rows: body,
		})
		const problems = element('div')
		const empty = element('p', {
			textContent: 'No credentials yet.',
			hidden: true,
		})
		list.replaceChildren(problems, empty, table)

		const showProblems = (...messages: string[]) => {
			problems.replaceChildren(...messages.map((message) => errorText(element, message)))
		}

		const view = (names: Answer<string[]>, providers: Answer<ListedProvider[]>) => {
			if (!names.ok) {
				showProblems(names.error)
				return
			}
			// Without the running engine there are no declared providers: the stored credentials still show.
			const shown = shownCredentials(names.value, providers.ok ? providers.value : [])
			shownRows = new Map(shown.map((credential) => [rowKey(credential), rowOf(credential)]))
			keepRows(body, [...shownRows.values()])
			empty.hidden = shown.length > 0
			showProblems(...(providers.ok ? [] : [`Provider keys can't be set now: ${providers.error}`]))
		}

		// Only the latest refresh is shown, so a slower earlier one can't put older rows back.
		let latestRefresh = 0
		async function show(): Promise<void> {
			latestRefresh += 1
			const refresh = latestRefresh
			const [names, providers] = await Promise.all([
				read('/settings/credentials', z.array(z.string()), signal),
				read('/settings/providers', z.array(ListedProvider), signal),
			])
			if (signal.aborted || refresh !== latestRefresh) return
			view(names, providers)
		}

		/** Puts the cursor in the row the address links to, such as `#provider/anthropic`: a credential's name needs no escaping. */
		const focusLinked = () => {
			const linked = location.hash.slice(1)
			if (linked === '') return
			list
				.querySelector(`tr[id="${CSS.escape(linked)}"]`)
				?.querySelector('input')
				?.focus()
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
		window.addEventListener('hashchange', focusLinked, { signal })
		await show()
		focusLinked()
	},
})
