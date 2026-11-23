import { component } from '@rooted/components'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read } from '../_shared/api.mts'
import { poll } from '../_shared/poll.mts'
import { SignInState } from '../_shared/settings.mts'
import styles from './settings.css'

/** The connector sign-ins under way: where to sign in, with which code and until when. Polls. */
export const SignInsUnderWay = component({
	name: 'sign-ins-under-way',
	styles,
	onMount({ append, element, create, signal }) {
		const signIns = element('div', {
			classes: styles.section,
		})

		const signInRow = ({ connector, prompt, error }: SignInState) =>
			element('tr', {
				children: [
					element('td', {
						textContent: connector,
					}),
					element('td', {
						children:
							prompt === undefined
								? 'Waiting for a code'
								: element('a', {
										href: prompt.url,
										target: '_blank',
										rel: 'noreferrer',
										textContent: prompt.url,
									}),
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

		const showSignIns = async (abortSignal: AbortSignal) => {
			const underWay = await read('/engine/sign-ins', z.array(SignInState), abortSignal)
			signIns.replaceChildren(
				!underWay.ok || underWay.value.length === 0
					? element('p', {
							classes: styles.muted,
							textContent: 'No sign-ins under way.',
						})
					: create(Table, {
							headings: ['Connector', 'Sign in at', 'Code', 'Until', 'Last try'],
							rows: underWay.value.map(signInRow),
						}),
			)
		}

		append(
			element('h2', {
				textContent: 'Sign-ins under way',
			}),
			signIns,
		)
		poll(showSignIns, signal)
	},
})
