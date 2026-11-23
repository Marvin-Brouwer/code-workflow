import { component } from '@rooted/components'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { onChange } from '../_shared/live-events.mts'
import { refresher } from '../_shared/refresher.mts'
import { SignInState } from '../_shared/settings.mts'
import styles from './settings.css'

const webProtocols: readonly string[] = ['http:', 'https:']

/** Whether `url` is a web address, and so safe to link to. */
function isWebAddress(url: string): boolean {
	return webProtocols.includes(URL.parse(url)?.protocol ?? '')
}

/** The connector sign-ins under way: where to sign in, with which code and until when. Live. */
export const SignInsUnderWay = component({
	name: 'sign-ins-under-way',
	styles,
	onMount({ append, element, create, signal }) {
		const signIns = element('div', {
			classes: styles.section,
		})

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

		const showSignIns = async (abortSignal: AbortSignal) => {
			signIns.replaceChildren(signInsView(await read('/engine/sign-ins', z.array(SignInState), abortSignal)))
		}

		append(
			element('h2', {
				textContent: 'Sign-ins under way',
			}),
			signIns,
		)
		const refresh = refresher(showSignIns, signal)
		onChange((change) => {
			if (change.kind !== 'run') refresh()
		}, signal)
		refresh()
	},
})
