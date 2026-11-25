import { component } from '@rooted/components'
import { z } from 'zod'
import { CredentialForm } from '../_forms/credential-form.mts'
import { CredentialRowForm } from '../_forms/credential-row-form.mts'
import { keepRows, Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ListedProvider } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'
import { rowKey, shownCredentials, type ShownCredential } from './shown-credentials.mts'

/**
 * The credentials by name, never their values, and the keys of the app's providers: set, replace
 * or clear one in its row, or set another one, such as a generated webhook secret. A refresh keeps
 * the rows that didn't change in place, with what's typed in them. A stored provider key whose
 * provider the config doesn't declare can only be cleared. A link to `#<name>` puts the cursor in
 * that credential's row.
 */
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
		table.hidden = true
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
				table.hidden = shownRows.size === 0
				return
			}
			// Without the running engine there are no declared providers: the stored credentials still show.
			const shown = shownCredentials(names.value, providers.ok ? providers.value : [])
			shownRows = new Map(shown.map((credential) => [rowKey(credential), rowOf(credential)]))
			keepRows(body, [...shownRows.values()])
			empty.hidden = shown.length > 0
			table.hidden = shown.length === 0
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

		/** Puts the cursor in the row the address links to, such as `#provider/anthropic`. The hash is used as it is: a credential's name needs no URL decoding. */
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
