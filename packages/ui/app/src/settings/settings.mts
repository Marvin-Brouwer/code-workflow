import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { settingsPages } from './settings-pages.mts'

/** What the settings are, with a link to each page. */
export const SettingsPage = component({
	name: 'settings-page',
	onMount({ append, element, create }) {
		append(
			element('h1', {
				textContent: 'Settings',
			}),
			element('p', {
				textContent:
					"Credentials, connectors and removing a provider's key work on the engine home's files, without a running engine, and a running one sees a change at once. The providers and setting their keys need mesh-flow serve, since the deployed app declares the providers.",
			}),
			element('ul', {
				children: settingsPages.map(({ route, label, description }) =>
					element('li', {
						children: [
							create(Link, {
								href: href.for(route),
								children: label,
							}),
							` ${description}`,
						],
					}),
				),
			}),
		)
	},
})
