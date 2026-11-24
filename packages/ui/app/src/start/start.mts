import { component } from '@rooted/components'
import { href, navigate } from '@rooted/router'
import { SchemaForm } from '../_forms/schema-form.mts'
import { send } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { noAppText } from '../_shared/no-app-text.mts'
import { RunRecord } from '../_shared/runs.mts'
import { readTheApp } from '../_shared/the-app.mts'
import { RunRoute } from '../runs/_routes.mts'
import { MissingSettings } from './missing-settings.mts'
import { userTriggersOf } from './user-triggers.mts'

/** Which button the page starts. */
export interface StartPageOptions {
	readonly trigger: string
}

/**
 * Starts a workflow from one of the app's buttons. First what the app still needs, then the
 * workflow's parameters as a form; starting goes to the new run.
 */
export const StartPage = component<StartPageOptions>({
	name: 'start-page',
	async onMount({ append, element, create, options, signal }) {
		const { trigger: triggerId } = options
		const heading = append(
			element('h1', {
				textContent: `Start ${triggerId}`,
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
		const trigger = userTriggersOf(app).find(({ id }) => id === triggerId)
		const workflow = app.manifest.description.workflows.find(({ name }) => name === trigger?.workflow)
		if (workflow === undefined) {
			content.replaceChildren(errorText(element, `There is no button ${triggerId}.`))
			return
		}
		heading.textContent = `Start ${workflow.name}`

		// One key for this page, so a start sent again, such as after the engine restarted, starts one run.
		const key = `ui-${crypto.randomUUID()}`
		const start = async (input: unknown, abortSignal: AbortSignal) => {
			const started = await send('POST', '/engine/runs', { trigger: { kind: 'user', id: triggerId }, input, key }, RunRecord, abortSignal)
			if (started.ok) navigate(href.for(RunRoute, { id: started.value.id }))
			return started
		}

		content.replaceChildren(
			create(MissingSettings, {
				complete() {
					content.replaceChildren(
						element('h2', {
							textContent: 'Parameters',
						}),
						create(SchemaForm, {
							schema: workflow.parameters,
							submitLabel: 'Start',
							send: start,
						}),
					)
				},
			}),
		)
	},
})
