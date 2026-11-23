import { component } from '@rooted/components'

type TableOptions = {
	/** The column headings, in order. An empty one leaves a column without a heading. */
	readonly headings: readonly string[]
	readonly rows: readonly HTMLElement[]
}

/** A table with one row of headings over `rows`. */
export const Table = component<TableOptions>({
	name: 'data-table',
	onMount({ append, element, options }) {
		append(
			element('table', {
				children: [
					element('thead', {
						children: element('tr', {
							children: options.headings.map((heading) =>
								element('th', {
									textContent: heading,
								}),
							),
						}),
					}),
					element('tbody', {
						children: [...options.rows],
					}),
				],
			}),
		)
	},
})
