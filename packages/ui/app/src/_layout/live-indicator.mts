import { component, match } from '@rooted/components'
import { engineStatus } from '../_shared/engine-status.mts'
import { liveStatus, type LiveStatus } from '../_shared/live-changes.mts'

/**
 * Whether runs update as they change, so a view that stopped updating says so instead of looking
 * current. Shown while an engine runs; the banner covers the rest.
 */
export const LiveIndicator = component({
	name: 'live-indicator',
	onMount({ append, element, signal }) {
		const shown = append(
			element('span', {
				role: 'status',
			}),
		)
		const show = () => {
			shown.hidden = engineStatus.value !== 'running'
			shown.textContent = match<LiveStatus, string>(liveStatus.value, {
				connecting: 'Connecting…',
				live: 'Live',
				reconnecting: 'Reconnecting: refreshing every 2 seconds meanwhile',
			})
		}
		show()
		liveStatus.on('change', signal, show)
		engineStatus.on('change', signal, show)
	},
})
