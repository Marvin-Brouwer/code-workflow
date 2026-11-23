import { component } from '@rooted/components'
import { application } from '@rooted/components/application'
import { router } from '@rooted/router/application'
import { EngineBanner } from './_layout/engine-banner.mts'
import { NavigationMenu } from './_layout/navigation-menu.mts'
import { appRoutes } from './_routes.g.mts'
import { watchEngineStatus } from './_shared/engine-status.mts'
import { watchEngineEvents } from './_shared/live-events.mts'
import styles from './application.css'
import { HomePage } from './navigation/home.mts'
import { NotFoundPage } from './navigation/not-found.mts'

const Router = router({
	home: HomePage,
	notFound: NotFoundPage,
	...appRoutes,
})

/** The shell: the menu, whether the engine runs, and the page the address names. */
export const Application = component({
	name: 'mesh-flow-application',
	styles,
	onMount({ append, element, create, signal }) {
		watchEngineStatus(signal)
		watchEngineEvents(signal)
		append(
			element('header', {
				children: [create(NavigationMenu), create(EngineBanner)],
			}),
			element('main', {
				id: 'main-content',
				children: create(Router),
			}),
		)
	},
})

application(Application)
