import { component } from '@rooted/components'
import { RunsStart } from '../start/runs-start.mts'
import { RunsList } from './runs-list.mts'

/** The runs page: what the app still needs, a new run, and every run. */
export const RunsPage = component({
	name: 'runs-page',
	onMount({ append, element, create }) {
		append(
			element('h1', {
				textContent: 'Runs',
			}),
			create(RunsStart),
			create(RunsList),
		)
	},
})
