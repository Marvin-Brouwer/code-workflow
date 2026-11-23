import { component, optional } from '@rooted/components'
import { z } from 'zod'
import { read, send } from '../_shared/api.mts'
import { ConnectorPackage, ShownConnector } from '../_shared/settings.mts'
import styles from './settings.css'
import { Table } from '../_layout/table.mts'
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

		const showPackages = async () => {
			const listed = await read('/settings/connectors', z.array(ConnectorPackage), signal)
			packages.replaceChildren(
				!listed.ok
					? element('p', {
							role: 'alert',
							textContent: listed.error,
						})
					: listed.value.length === 0
						? element('p', {
								textContent: 'No connector packages yet.',
							})
						: create(Table, {
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
							}),
			)
		}

		const showLoaded = async () => {
			const connectors = await read('/engine/connectors', z.array(ShownConnector), signal)
			loaded.replaceChildren(
				!connectors.ok
					? element('p', {
							classes: styles.muted,
							textContent: connectors.error,
						})
					: connectors.value.length === 0
						? element('p', {
								textContent: 'The engine loaded no connectors.',
							})
						: create(Table, {
								headings: ['Name', 'Package', ''],
								rows: connectors.value.map(({ name, package: from, signsIn }) =>
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
									}),
								),
							}),
			)
		}

		append(
			create(SettingsMenu),
			element('h1', {
				textContent: 'Connectors',
			}),
			element('p', {
				textContent:
					'A connector is a package installed where the engine runs: add one with `mesh-flow connector add <package>` and start the engine again.',
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
