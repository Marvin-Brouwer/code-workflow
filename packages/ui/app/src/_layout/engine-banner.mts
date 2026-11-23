import { component } from '@rooted/components'
import { engineStatus, type EngineStatus } from '../_shared/engine-status.mts'
import styles from './engine-banner.css'

/** Says so when no engine is running, as runs and triggers need one, or when this page has no access any more. */
export const EngineBanner = component({
	name: 'engine-banner',
	styles,
	onMount({ append, element, signal }) {
		const banner = (before: string, command: string, after: string) =>
			append(
				element('p', {
					classes: styles.banner,
					role: 'status',
					hidden: true,
					children: [
						before,
						element('code', {
							textContent: command,
						}),
						after,
					],
				}),
			)
		const stopped = banner(
			'No engine is running. Runs and triggers need one: start it with ',
			'mesh-flow serve',
			'. Settings work without it.',
		)
		const noAccess = banner('This page has no access any more. Open the address ', 'mesh-flow ui', ' printed.')
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
