import { component, optional } from '@rooted/components'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read, send, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { ConnectorPackage, ShownConnector } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'
import { SignInsUnderWay } from './sign-ins.mts'

/**
 * The connector packages the engine loads, and with a running engine, the connectors it loaded and
 * their sign-ins: start one, and see where to sign in and with which code below.
 */
export const ConnectorsPage = component({
	name: 'connectors-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const packages = element('div', {
			classes: styles.section,
		})
		const loaded = element('div', {
			classes: styles.section,
		})
		const status = element('p', {
			role: 'status',
		})

		const signIn = async (connector: string) => {
			status.textContent = `Waiting for you to sign in to ${connector}: the code shows below.`
			const answer = await send('POST', `/engine/sign-ins/${encodeURIComponent(connector)}`, {}, z.object({ signedIn: z.string() }), signal)
			if (signal.aborted) return
			status.textContent = answer.ok ? `Signed in to ${connector}.` : answer.error
		}

		const packagesView = (listed: Answer<ConnectorPackage[]>) => {
			if (!listed.ok) return errorText(element, listed.error)
			if (listed.value.length === 0)
				return element('p', {
					textContent: 'No connector packages yet.',
				})
			return create(Table, {
				headings: ['Package'],
				rows: listed.value.map(({ package: name }) =>
					element('tr', {
						children: element('td', {
							children: element('code', {
								textContent: name,
							}),
						}),
					}),
				),
			})
		}

		const loadedRow = ({ name, package: from, signsIn }: ShownConnector) =>
			element('tr', {
				children: [
					element('td', {
						textContent: name,
					}),
					element('td', {
						children: element('code', {
							textContent: from,
						}),
					}),
					element('td', {
						children: optional(
							signsIn,
							element('button', {
								type: 'button',
								textContent: 'Sign in',
								on: {
									click() {
										void signIn(name)
									},
								},
							}),
						),
					}),
				],
			})

		const loadedView = (connectors: Answer<ShownConnector[]>) => {
			if (!connectors.ok)
				return element('p', {
					classes: styles.muted,
					textContent: connectors.error,
				})
			if (connectors.value.length === 0)
				return element('p', {
					textContent: 'The engine loaded no connectors.',
				})
			return create(Table, {
				headings: ['Name', 'Package', ''],
				rows: connectors.value.map(loadedRow),
			})
		}

		const showPackages = async () => {
			packages.replaceChildren(packagesView(await read('/settings/connectors', z.array(ConnectorPackage), signal)))
		}
		const showLoaded = async () => {
			loaded.replaceChildren(loadedView(await read('/engine/connectors', z.array(ShownConnector), signal)))
		}

		append(
			create(SettingsMenu),
			element('h1', {
				textContent: 'Connectors',
			}),
			element('p', {
				children: [
					'A connector is a package installed where the engine runs: add one with ',
					element('code', {
						textContent: 'mesh-flow connector add <package>',
					}),
					' and start the engine again.',
				],
			}),
			element('h2', {
				textContent: 'Packages',
			}),
			packages,
			element('h2', {
				textContent: 'Loaded by the engine',
			}),
			loaded,
			status,
			create(SignInsUnderWay),
		)
		await Promise.all([showPackages(), showLoaded()])
	},
})
