import { component } from '@rooted/components'
import { RunsList } from '../runs/runs-list.mts'

/** The first page: the runs, those that need someone on top. */
export const HomePage = component({
	name: 'home-page',
	onMount({ append, element, create }) {
		append(element('h1', { textContent: 'Runs' }), create(RunsList))
	},
})
