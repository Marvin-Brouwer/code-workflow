import { component } from '@rooted/components'

/** The first page. The runs, apps and settings pages come next. */
export const HomePage = component({
	name: 'home-page',
	onMount({ append, element }) {
		append(
			element('h1', {
				textContent: 'mesh-flow',
			}),
			element('p', {
				textContent: 'Runs, apps and settings will be here.',
			}),
		)
	},
})
