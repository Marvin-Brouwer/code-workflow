import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { settingsPages } from './settings-pages.mts'
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
				children: settingsPages.map(({ route, label }) =>
					create(Link, {
						href: href.for(route),
						children: label,
					}),
				),
			}),
		)
	},
})
