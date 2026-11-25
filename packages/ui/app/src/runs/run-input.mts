import { component } from '@rooted/components'
import { z } from 'zod'
import { read } from '../_shared/api.mts'
import styles from './run.css'

/** The run whose input is shown. */
interface RunInputOptions {
	readonly run: string
}

/** What a run was started with, as the trigger gave it: a form's values or a webhook's payload. */
export const RunInput = component<RunInputOptions>({
	name: 'run-input',
	styles,
	async onMount({ append, element, options, signal }) {
		const answer = await read(`/engine/runs/${encodeURIComponent(options.run)}/input`, z.object({ input: z.unknown() }), signal)
		if (signal.aborted) return
		if (!answer.ok) {
			append(
				element('p', {
					role: 'alert',
					textContent: answer.error,
				}),
			)
			return
		}
		append(
			element('h2', {
				textContent: 'Input',
			}),
			element('pre', {
				classes: styles.input,
				textContent: answer.value.input === undefined ? 'No input.' : JSON.stringify(answer.value.input, undefined, '\t'),
			}),
		)
	},
})
