import { component } from '@rooted/components'

/** The table's headings and rows. */
interface TableOptions {
	/** The column headings, in order. An empty one leaves a column without a heading. */
	readonly headings: readonly string[]
	/** The rows, each a `tr`, or a `tbody` the caller keeps up to date with {@link keepRows}. */
	readonly rows: readonly HTMLElement[] | HTMLTableSectionElement
}

/** A table with one row of headings over `rows`. */
export const Table = component<TableOptions>({
	name: 'data-table',
	onMount({ append, element, options }) {
		const { rows } = options
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
					rows instanceof HTMLTableSectionElement
						? rows
						: element('tbody', {
								children: [...rows],
							}),
				],
			}),
		)
	},
})

/**
 * Makes `body` hold `rows`, in their order, without moving a row it holds already: a component in a
 * row that's moved mounts again, so a row that stays keeps what's typed in it and what it's sending.
 * The rows it keeps have to be in the same order among themselves as they were.
 */
export function keepRows(body: HTMLTableSectionElement, rows: readonly Element[]): void {
	// A static list, since removing from the live `children` while going through it would skip rows.
	for (const shown of body.querySelectorAll(':scope > tr')) if (!rows.includes(shown)) shown.remove()
	for (const [index, row] of rows.entries()) {
		const atIndex = body.children.item(index)
		if (atIndex !== row) body.insertBefore(row, atIndex)
	}
}
