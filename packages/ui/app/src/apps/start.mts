import { component } from '@rooted/components'
import { href, navigate } from '@rooted/router'
import { z } from 'zod'
import { FixForm } from '../_forms/fix-form.mts'
import { SchemaForm } from '../_forms/schema-form.mts'
import { read, send } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { DeployedApp, RunRecord } from '../_shared/runs.mts'
import { MissingSetting } from '../_shared/settings.mts'
import { RunRoute } from '../runs/_routes.mts'

/** Which app's button the page starts. */
export interface StartPageOptions {
	readonly app: string
	readonly trigger: string
}

/**
 * Starts a workflow from one of its app's buttons. First the wizard: a form for each setting the
 * app still needs, such as a provider key or a token, asked again after each is set. With nothing
 * missing, the workflow's parameters as a form; starting goes to the new run.
 */
export const StartPage = component<StartPageOptions>({
	name: 'start-page',
	async onMount({ append, element, create, options, signal }) {
		const { app: appName, trigger: triggerId } = options
		const heading = append(
			element('h1', {
				textContent: `Start ${triggerId}`,
			}),
		)
		const content = append(element('div'))

		const apps = await read('/engine/apps', z.array(DeployedApp), signal)
		const app = apps.ok ? apps.value.find(({ name }) => name === appName) : undefined
		const trigger = app?.manifest.description.triggers.find(({ kind, id }) => kind === 'user' && id === triggerId)
		const workflow = app?.manifest.description.workflows.find(({ name }) => name === trigger?.workflow)
		if (!apps.ok || workflow === undefined) {
			content.replaceChildren(errorText(element, apps.ok ? `${appName} has no button ${triggerId}.` : apps.error))
			return
		}
		heading.textContent = `Start ${workflow.name} of ${appName}`

		// One key for this page, so a start sent again, such as after the engine restarted, starts one run.
		const key = `ui-${crypto.randomUUID()}`
		const start = async (input: unknown, abortSignal: AbortSignal) => {
			const started = await send(
				'POST',
				'/engine/runs',
				{ app: appName, trigger: { kind: 'user', id: triggerId }, input, key },
				RunRecord,
				abortSignal,
			)
			if (started.ok) navigate(href.for(RunRoute, { id: started.value.id }))
			return started
		}

		const show = async (): Promise<void> => {
			const missing = await read(`/engine/apps/${encodeURIComponent(appName)}/missing`, z.array(MissingSetting), signal)
			if (signal.aborted) return
			if (!missing.ok) {
				content.replaceChildren(errorText(element, missing.error))
				return
			}
			if (missing.value.length > 0) {
				content.replaceChildren(
					element('h2', {
						textContent: 'First, what it still needs',
					}),
					...missing.value.map((setting) =>
						element('section', {
							children: create(FixForm, {
								setting,
								done() {
									void show()
								},
							}),
						}),
					),
					element('button', {
						type: 'button',
						textContent: 'Check again',
						on: {
							click() {
								void show()
							},
						},
					}),
				)
				return
			}
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
		}
		await show()
	},
})
