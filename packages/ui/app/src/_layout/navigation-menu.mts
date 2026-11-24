import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { AppsRoute } from '../apps/_routes.mts'
import { RunsRoute } from '../runs/_routes.mts'
import { SettingsRoute } from '../settings/_routes.mts'
import { LiveIndicator } from './live-indicator.mts'
import styles from './navigation-menu.css'

/** The pages, as links across the top. */
export const NavigationMenu = component({
	name: 'navigation-menu',
	styles,
	onMount({ append, element, create }) {
		append(
			element('nav', {
				classes: styles.menu,
				aria: {
					label: 'Main',
				},
				children: [
					create(Link, {
						href: href.path('/'),
						classes: styles.brand,
						children: 'mesh-flow',
					}),
					create(Link, {
						href: href.for(RunsRoute),
						children: 'Runs',
					}),
					create(Link, {
						href: href.for(AppsRoute),
						children: 'Apps',
					}),
					create(Link, {
						href: href.for(SettingsRoute),
						children: 'Settings',
					}),
					element('span', {
						classes: styles.live,
						children: create(LiveIndicator),
					}),
				],
			}),
		)
	},
})
