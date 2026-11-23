import { component, optional } from '@rooted/components'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read, send, type Answer } from '../_shared/api.mts'
import { poll } from '../_shared/poll.mts'
import { ConnectorPackage, ShownConnector, SignInState } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/** Whether `url` is a web address, and so safe to link to. */
function isWebAddress(url: string): boolean {
	return URL.parse(url)?.protocol.startsWith('http') === true
}

/**
 * The connector packages the engine loads, and with a running engine, the connectors it loaded and
 * their sign-ins: start one, and see where to sign in and with which code.
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
		const signIns = element('div', {
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
			if (!listed.ok)
				return element('p', {
					role: 'alert',
					textContent: listed.error,
				})
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

		const signInAt = (prompt: SignInState['prompt']) => {
			if (prompt === undefined) return 'Waiting for a code'
			if (!isWebAddress(prompt.url)) return prompt.url
			return element('a', {
				href: prompt.url,
				target: '_blank',
				rel: 'noreferrer',
				textContent: prompt.url,
			})
		}

		const signInRow = ({ connector, prompt, error }: SignInState) =>
			element('tr', {
				children: [
					element('td', {
						textContent: connector,
					}),
					element('td', {
						children: signInAt(prompt),
					}),
					element('td', {
						children:
							prompt === undefined
								? undefined
								: element('code', {
										textContent: prompt.code,
									}),
					}),
					element('td', {
						textContent: prompt === undefined ? '' : new Date(prompt.expiresAt).toLocaleTimeString(),
					}),
					element('td', {
						textContent: error ?? '',
					}),
				],
			})

		const signInsView = (underWay: Answer<SignInState[]>) => {
			if (!underWay.ok || underWay.value.length === 0)
				return element('p', {
					classes: styles.muted,
					textContent: 'No sign-ins under way.',
				})
			return create(Table, {
				headings: ['Connector', 'Sign in at', 'Code', 'Until', 'Last try'],
				rows: underWay.value.map(signInRow),
			})
		}

		const showPackages = async () => {
			packages.replaceChildren(packagesView(await read('/settings/connectors', z.array(ConnectorPackage), signal)))
		}
		const showLoaded = async () => {
			loaded.replaceChildren(loadedView(await read('/engine/connectors', z.array(ShownConnector), signal)))
		}
		const showSignIns = async (abortSignal: AbortSignal) => {
			signIns.replaceChildren(signInsView(await read('/engine/sign-ins', z.array(SignInState), abortSignal)))
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
			element('h2', {
				textContent: 'Sign-ins under way',
			}),
			signIns,
		)
		await Promise.all([showPackages(), showLoaded()])
		poll(showSignIns, signal)
	},
})
