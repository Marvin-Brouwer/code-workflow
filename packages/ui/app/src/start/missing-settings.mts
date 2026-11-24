import { component } from '@rooted/components'
import { z } from 'zod'
import { FixForm } from '../_forms/fix-form.mts'
import { read } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { refresher } from '../_shared/refresher.mts'
import type { DeployedApp } from '../_shared/runs.mts'
import { MissingSetting } from '../_shared/settings.mts'
import { missingPath } from '../_shared/the-app.mts'

/** Whose settings, and what to do once nothing is missing. */
export interface MissingSettingsOptions {
	readonly app: DeployedApp
	/** Called once nothing is missing, at once when nothing was. Show what comes next. */
	readonly complete: () => void
}

/**
 * The wizard: a form for each setting the app still needs before a run can start, such as a
 * provider key or a token, asked again after each is set.
 */
export const MissingSettings = component<MissingSettingsOptions>({
	name: 'missing-settings',
	onMount({ append, element, create, options, signal }) {
		const { app, complete } = options
		const content = append(element('div'))
		const show = async (abortSignal: AbortSignal): Promise<void> => {
			const missing = await read(missingPath(app), z.array(MissingSetting), abortSignal)
			if (abortSignal.aborted) return
			if (!missing.ok) {
				content.replaceChildren(errorText(element, missing.error))
				return
			}
			if (missing.value.length === 0) {
				content.replaceChildren()
				complete()
				return
			}
			content.replaceChildren(
				element('h2', {
					textContent: 'First, what it still needs',
				}),
				...missing.value.map((setting) =>
					element('section', {
						children: create(FixForm, {
							setting,
							done() {
								refresh()
							},
						}),
					}),
				),
				element('button', {
					type: 'button',
					textContent: 'Check again',
					on: {
						click() {
							refresh()
						},
					},
				}),
			)
		}
		// A Set and a Check again close together run one after the other, so an older answer never shows last.
		const refresh = refresher(show, signal)
		refresh()
	},
})
