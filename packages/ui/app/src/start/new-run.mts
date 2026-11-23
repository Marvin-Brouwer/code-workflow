import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { errorText } from '../_shared/error-text.mts'
import { readTheApp } from '../_shared/the-app.mts'
import { StartRoute } from './_routes.mts'
import { userTriggersOf } from './user-triggers.mts'

/** A new run: the app's buttons, each a link to its start page. */
export const NewRunPage = component({
	name: 'new-run-page',
	async onMount({ append, element, create, signal }) {
		append(
			element('h1', {
				textContent: 'New run',
			}),
		)
		const theApp = await readTheApp(signal)
		if (!theApp.ok) {
			append(errorText(element, theApp.error))
			return
		}
		const triggers = userTriggersOf(theApp.value)
		if (triggers.length === 0) {
			append(
				element('p', {
					textContent: 'The app has no trigger a person starts.',
				}),
			)
			return
		}
		append(
			element('ul', {
				children: triggers.map((trigger) =>
					element('li', {
						children: create(Link, {
							href: href.for(StartRoute, { trigger: trigger.id }),
							children: `${trigger.id}: starts ${trigger.workflow}`,
						}),
					}),
				),
			}),
		)
	},
})
