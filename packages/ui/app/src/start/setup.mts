import { component } from '@rooted/components'
import { errorText } from '../_shared/error-text.mts'
import { noAppText } from '../_shared/no-app-text.mts'
import { readTheApp } from '../_shared/the-app.mts'
import { MissingSettings } from './missing-settings.mts'

/** What the app still needs before a run can start, each with the form that sets it. */
export const SetupPage = component({
	name: 'setup-page',
	async onMount({ append, element, create, signal }) {
		append(
			element('h1', {
				textContent: 'Set up',
			}),
		)
		const content = append(element('div'))
		const theApp = await readTheApp(signal)
		if (!theApp.ok) {
			content.replaceChildren(errorText(element, theApp.error))
			return
		}
		const app = theApp.value
		if (app === undefined) {
			content.replaceChildren(noAppText(element))
			return
		}
		content.replaceChildren(
			create(MissingSettings, {
				app,
				complete() {
					content.replaceChildren(
						element('p', {
							textContent: 'Nothing is missing: every run can start.',
						}),
					)
				},
			}),
		)
	},
})
