import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { ConnectorsRoute, CredentialsRoute, ProvidersRoute } from './_routes.mts'

/** What the settings are, with a link to each page. */
export const SettingsPage = component({
	name: 'settings-page',
	onMount({ append, element, create }) {
		const entry = (link: ReturnType<typeof create>, text: string) =>
			element('li', {
				children: [link, ` ${text}`],
			})
		append(
			element('h1', {
				textContent: 'Settings',
			}),
			element('p', {
				textContent: 'These work on the engine home’s files, without a running engine. A running one sees a change at once.',
			}),
			element('ul', {
				children: [
					entry(
						create(Link, {
							href: href.for(ProvidersRoute),
							children: 'Providers',
						}),
						'the model providers, in the order models are looked up, and their keys.',
					),
					entry(
						create(Link, {
							href: href.for(CredentialsRoute),
							children: 'Credentials',
						}),
						'tokens, webhook secrets and service settings; values never come back.',
					),
					entry(
						create(Link, {
							href: href.for(ConnectorsRoute),
							children: 'Connectors',
						}),
						'the connectors the engine loads, and signing in to their services.',
					),
				],
			}),
		)
	},
})
