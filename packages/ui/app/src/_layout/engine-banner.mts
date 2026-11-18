import { component } from '@rooted/components'
import { engineStatus } from '../_shared/engine-status.mts'
import styles from './engine-banner.css'

/** Says so when no engine is running: runs and apps need one, settings don't. */
export const EngineBanner = component({
	name: 'engine-banner',
	styles,
	onMount({ append, element, signal }) {
		const banner = append(
			element('p', {
				classes: styles.banner,
				role: 'status',
				textContent: 'No engine is running. Runs and apps need one: start it with `mesh-flow serve`. Settings work without it.',
			}),
		)
		const show = (status: string) => {
			banner.hidden = status !== 'stopped'
		}
		show(engineStatus.value)
		engineStatus.on('change', signal, ({ detail }) => {
			show(detail.state)
		})
	},
})
