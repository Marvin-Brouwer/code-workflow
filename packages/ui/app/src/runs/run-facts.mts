import { component } from '@rooted/components'
import type { RunRecord } from '../_shared/runs.mts'
import { shownTime } from './run-labels.mts'
import styles from './run.css'

/** The run the facts are of. */
interface RunFactsOptions {
	readonly record: RunRecord
}

/** What a run is: its status, workflow, app, who started it and when, and why it ended badly. */
export const RunFacts = component<RunFactsOptions>({
	name: 'run-facts',
	styles,
	onMount({ append, element, options }) {
		const { record } = options
		const fact = (term: string, value: string) =>
			element('div', {
				children: [
					element('dt', {
						textContent: term,
					}),
					element('dd', {
						textContent: value,
					}),
				],
			})
		append(
			element('dl', {
				classes: styles.facts,
				children: [
					fact('Status', record.status),
					fact('Workflow', record.workflow),
					fact('App', `${record.app.name} ${record.app.version}`),
					fact('Started by', `${record.trigger.kind} ${record.trigger.id}`),
					fact('Started', shownTime(record.createdAt)),
					fact('Last change', shownTime(record.updatedAt)),
					record.error === undefined ? undefined : fact('Error', record.error),
					record.reason === undefined ? undefined : fact('Skipped', record.reason),
				],
			}),
		)
	},
})
