import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'

/** What a path no page has shows. */
export const NotFoundPage = component({
	name: 'not-found-page',
	onMount({ append, element, create }) {
		append(
			element('h1', {
				textContent: 'There is no such page',
			}),
			create(Link, {
				href: href.path('/'),
				children: 'Back to the start',
			}),
		)
	},
})
