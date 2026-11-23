import { component } from '@rooted/components'
import { engineStatus, type EngineStatus } from '../_shared/engine-status.mts'
import styles from './engine-banner.css'

/** Says so when no engine is running, as runs and apps need one, or when this page has no access any more. */
export const EngineBanner = component({
	name: 'engine-banner',
	styles,
	onMount({ append, element, signal }) {
		const stopped = append(
			element('p', {
				classes: styles.banner,
				role: 'status',
				children: [
					'No engine is running. Runs and apps need one: start it with ',
					element('code', {
						textContent: 'mesh-flow serve',
					}),
					'. Settings work without it.',
				],
			}),
		)
		const noAccess = append(
			element('p', {
				classes: styles.banner,
				role: 'status',
				children: [
					'This page has no access any more. Open the address ',
					element('code', {
						textContent: 'mesh-flow ui',
					}),
					' printed.',
				],
			}),
		)
		const show = (status: EngineStatus) => {
			stopped.hidden = status !== 'stopped'
			noAccess.hidden = status !== 'no-access'
		}
		show(engineStatus.value)
		engineStatus.on('change', signal, ({ detail }) => {
			show(detail.state)
		})
	},
})
