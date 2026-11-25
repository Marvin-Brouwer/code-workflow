import { choice, component } from '@rooted/components'
import { Table } from '../_layout/table.mts'
import type { RunRecord } from '../_shared/runs.mts'

/** How many decimals a cost shows: a cent's hundredth, as small requests cost. */
const costDecimals = 4

/** What the run used. */
interface RunUsageOptions {
	/** What each model used, under the model's name. */
	readonly usage: NonNullable<RunRecord['usage']>
	/** Whether the run still goes on, so this is what it used so far. */
	readonly live: boolean
}

/** What a run's agents used, a row per model: so far while it goes on, all of it once it's over. */
export const RunUsage = component<RunUsageOptions>({
	name: 'run-usage',
	onMount({ append, element, create, options }) {
		append(
			element('h2', {
				textContent: choice(options.live, 'Usage so far', 'Usage'),
			}),
			create(Table, {
				headings: ['Model', 'Requests', 'Input tokens', 'Output tokens', 'Cost (USD)'],
				rows: Object.entries(options.usage).map(([model, used]) =>
					element('tr', {
						children: [model, used.requests, used.inputTokens, used.outputTokens, used.costUsd.toFixed(costDecimals)].map((value) =>
							element('td', {
								textContent: String(value),
							}),
						),
					}),
				),
			}),
		)
	},
})
