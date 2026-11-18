import { component } from '@rooted/components'
import { z } from 'zod'
import { read, send } from '../_shared/api.mts'
import { poll } from '../_shared/poll.mts'
import { ConnectorPackage, ShownConnector, SignInState } from '../_shared/settings.mts'
import styles from './settings.css'
import { SettingsMenu } from './settings-menu.mts'

/**
 * The connector packages the engine loads, and with a running engine, the connectors it loaded and
 * their sign-ins: start one, and see where to sign in and with which code.
 */
export const ConnectorsPage = component({
	name: 'connectors-page',
	styles,
	async onMount({ append, element, create, signal }) {
		const packages = element('div', { classes: styles.section })
		const loaded = element('div', { classes: styles.section })
		const signIns = element('div', { classes: styles.section })
		const status = element('p', { role: 'status' })

		const table = (headings: readonly string[], rows: HTMLElement[]) =>
			element('table', {
				children: [
					element('thead', { children: element('tr', { children: headings.map((heading) => element('th', { textContent: heading })) }) }),
					element('tbody', { children: rows }),
				],
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
					? element('p', { role: 'alert', textContent: listed.error })
					: listed.value.length === 0
						? element('p', { textContent: 'No connector packages yet.' })
						: table(
								['Package'],
								listed.value.map(({ package: name }) =>
									element('tr', { children: element('td', { children: element('code', { textContent: name }) }) }),
								),
							),
			)
		}

		const showLoaded = async () => {
			const connectors = await read('/engine/connectors', z.array(ShownConnector), signal)
			loaded.replaceChildren(
				!connectors.ok
					? element('p', { classes: styles.muted, textContent: connectors.error })
					: connectors.value.length === 0
						? element('p', { textContent: 'The engine loaded no connectors.' })
						: table(
								['Name', 'Package', ''],
								connectors.value.map(({ name, package: from, signsIn }) =>
									element('tr', {
										children: [
											element('td', { textContent: name }),
											element('td', { children: element('code', { textContent: from }) }),
											element('td', {
												children: signsIn
													? element('button', {
															type: 'button',
															textContent: 'Sign in',
															on: {
																click() {
																	void signIn(name)
																},
															},
														})
													: undefined,
											}),
										],
									}),
								),
							),
			)
		}

		const signInRow = ({ connector, prompt, error }: SignInState) =>
			element('tr', {
				children: [
					element('td', { textContent: connector }),
					element('td', {
						children:
							prompt === undefined
								? 'Waiting for a code'
								: element('a', { href: prompt.url, target: '_blank', rel: 'noreferrer', textContent: prompt.url }),
					}),
					element('td', { children: prompt === undefined ? undefined : element('code', { textContent: prompt.code }) }),
					element('td', { textContent: prompt === undefined ? '' : new Date(prompt.expiresAt).toLocaleTimeString() }),
					element('td', { textContent: error ?? '' }),
				],
			})

		const showSignIns = async (abortSignal: AbortSignal) => {
			const underWay = await read('/engine/sign-ins', z.array(SignInState), abortSignal)
			signIns.replaceChildren(
				!underWay.ok || underWay.value.length === 0
					? element('p', { classes: styles.muted, textContent: 'No sign-ins under way.' })
					: table(['Connector', 'Sign in at', 'Code', 'Until', 'Last try'], underWay.value.map(signInRow)),
			)
		}

		append(
			create(SettingsMenu),
			element('h1', { textContent: 'Connectors' }),
			element('p', {
				textContent:
					'A connector is a package installed where the engine runs: add one with `mesh-flow connector add <package>` and start the engine again.',
			}),
			element('h2', { textContent: 'Packages' }),
			packages,
			element('h2', { textContent: 'Loaded by the engine' }),
			loaded,
			status,
			element('h2', { textContent: 'Sign-ins under way' }),
			signIns,
		)
		await Promise.all([showPackages(), showLoaded()])
		poll(showSignIns, signal)
	},
})
