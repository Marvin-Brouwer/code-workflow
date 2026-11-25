import { choice, component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read, type Answer } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { onChange } from '../_shared/live-events.mts'
import { refresher } from '../_shared/refresher.mts'
import { RunRecord } from '../_shared/runs.mts'
import { RunRoute } from './_routes.mts'
import { actOn, isArchived, runActions, type RunAction } from './run-actions.mts'
import { inListOrder, shownTime, waitsOn } from './run-labels.mts'

/** What a run's row lets a person do: carry it on, or put it away. Stopping is on the run's own page. */
const rowActions: readonly RunAction[] = ['resume', 'restart', 'archive', 'unarchive']

/**
 * Every run that isn't archived, or with the box ticked, every archived one: workflow, status and
 * what it waits on, those that need someone on top, with what can be done to each. Live.
 */
export const RunsList = component({
	name: 'runs-list',
	onMount({ append, element, create, signal }) {
		const actionError = element('p', {
			role: 'alert',
		})
		let showArchived = false
		const archivedBox = element('input', {
			type: 'checkbox',
			on: {
				change() {
					showArchived = archivedBox.checked
					refresh()
				},
			},
		})
		append(
			element('label', {
				children: [archivedBox, 'Show archived runs'],
			}),
		)
		const list = append(element('div'))
		append(actionError)

		// One action per run at a time, so a double click doesn't send a second one that's refused.
		const acting = new Set<string>()
		const act = async (id: string, action: RunAction) => {
			if (acting.has(id)) return
			acting.add(id)
			const answer = await actOn(id, action, signal)
			acting.delete(id)
			if (signal.aborted) return
			actionError.textContent = answer.ok ? '' : answer.error
			refresh()
		}

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
						textContent: record.status,
					}),
					element('td', {
						textContent: waitsOn(record.pending),
					}),
					element('td', {
						textContent: shownTime(record.updatedAt),
					}),
					element('td', {
						children: runActions(record, rowActions).map(({ action, label }) =>
							element('button', {
								type: 'button',
								textContent: label,
								ariaLabel: `${label} ${record.id}`,
								on: {
									click() {
										void act(record.id, action)
									},
								},
							}),
						),
					}),
				],
			})

		const runsView = (runs: Answer<RunRecord[]>) => {
			if (!runs.ok) return errorText(element, runs.error)
			const shown = runs.value.filter((record) => isArchived(record) === showArchived)
			if (shown.length === 0)
				return element('p', {
					textContent: choice(showArchived, 'No archived runs.', 'No runs yet.'),
				})
			return create(Table, {
				headings: ['Run', 'Workflow', 'Status', 'Waits on', 'Last change', 'Actions'],
				rows: inListOrder(shown).map(row),
			})
		}

		// A run's events change no record, but tell the list too: it's drawn again only when what it shows changed,
		// so a busy run doesn't replace the buttons under someone's pointer.
		let drawn = ''
		const show = async (abortSignal: AbortSignal) => {
			const runs = await read('/engine/runs', z.array(RunRecord), abortSignal)
			if (abortSignal.aborted) return
			const shown = JSON.stringify({ runs, showArchived })
			if (shown === drawn) return
			drawn = shown
			list.replaceChildren(runsView(runs))
		}

		const refresh = refresher(show, signal)
		onChange((change) => {
			if (change.kind !== 'sign-in') refresh()
		}, signal)
		refresh()
	},
})
