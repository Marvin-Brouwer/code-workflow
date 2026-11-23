import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read } from '../_shared/api.mts'
import { onChange } from '../_shared/live-events.mts'
import { refresher } from '../_shared/refresher.mts'
import { RunRecord } from '../_shared/runs.mts'
import { RunRoute } from './_routes.mts'
import { inListOrder, shownTime, waitsOn } from './run-labels.mts'

/** Every run: workflow, app, status and what it waits on, those that need someone on top. Live. */
export const RunsList = component({
	name: 'runs-list',
	onMount({ append, element, create, signal }) {
		const list = append(element('div'))

		const row = (record: RunRecord) =>
			element('tr', {
				children: [
					element('td', {
						children: create(Link, {
							href: href.for(RunRoute, { id: record.id }),
							children: record.id,
						}),
					}),
					element('td', {
						textContent: record.workflow,
					}),
					element('td', {
						textContent: record.app.name,
					}),
					element('td', {
						textContent: record.status,
					}),
					element('td', {
						textContent: waitsOn(record.pending),
					}),
					element('td', {
						textContent: shownTime(record.updatedAt),
					}),
				],
			})

		const show = async (abortSignal: AbortSignal) => {
			const runs = await read('/engine/runs', z.array(RunRecord), abortSignal)
			if (abortSignal.aborted) return
			if (!runs.ok) {
				list.replaceChildren(
					element('p', {
						role: 'alert',
						textContent: runs.error,
					}),
				)
				return
			}
			list.replaceChildren(
				runs.value.length === 0
					? element('p', {
							textContent: 'No runs yet. Start one from its app.',
						})
					: create(Table, {
							headings: ['Run', 'Workflow', 'App', 'Status', 'Waits on', 'Last change'],
							rows: inListOrder(runs.value).map(row),
						}),
			)
		}

		const refresh = refresher(show, signal)
		onChange((change) => {
			if (change.kind !== 'sign-in') refresh()
		}, signal)
		refresh()
	},
})
