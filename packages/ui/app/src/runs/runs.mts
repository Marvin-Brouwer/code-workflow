import { component } from '@rooted/components'
import { RunsList } from './runs-list.mts'

/** The runs page. */
export const RunsPage = component({
	name: 'runs-page',
	onMount({ append, element, create }) {
		append(
			element('h1', {
				textContent: 'Runs',
			}),
			create(RunsList),
		)
	},
})
