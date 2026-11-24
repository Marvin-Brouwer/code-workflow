import { component } from '@rooted/components'
import { RunsList } from '../runs/runs-list.mts'
import { RunsStart } from '../start/runs-start.mts'

/** The first page: what the app still needs, a new run, and the runs, those that need someone on top. */
export const HomePage = component({
	name: 'home-page',
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
