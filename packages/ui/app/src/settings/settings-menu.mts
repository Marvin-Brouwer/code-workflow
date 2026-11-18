import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { ConnectorsRoute, CredentialsRoute, ProvidersRoute } from './_routes.mts'
import styles from './settings.css'

/** Links between the settings pages. */
export const SettingsMenu = component({
	name: 'settings-menu',
	styles,
	onMount({ append, element, create }) {
		append(
			element('nav', {
				classes: styles.menu,
				aria: {
					label: 'Settings',
				},
				children: [
					create(Link, { href: href.for(ProvidersRoute), children: 'Providers' }),
					create(Link, { href: href.for(CredentialsRoute), children: 'Credentials' }),
					create(Link, { href: href.for(ConnectorsRoute), children: 'Connectors' }),
				],
			}),
		)
	},
})
