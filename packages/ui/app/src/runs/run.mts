import { component } from '@rooted/components'
import { z } from 'zod'
import { read, send, type Answer } from '../_shared/api.mts'
import { onChange } from '../_shared/live-changes.mts'
import { refresher } from '../_shared/refresher.mts'
import { RunEvent, RunRecord, type RunStatus } from '../_shared/runs.mts'
import { shownTime } from './run-labels.mts'
import { RunRequestView } from './run-requests.mts'
import { stepsOf } from './run-steps.mts'
import { StepBar, type OpenState } from './step-bar.mts'
import styles from './run.css'

export interface RunPageOptions {
	readonly id: string
}

/** Statuses a run never leaves on its own. */
const finished: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'stopped', 'skipped'])

/** What can be done to a run, and in which statuses the engine takes it. */
const actions = [
	{ action: 'stop', label: 'Stop', when: ['starting', 'running', 'paused', 'restartable'] },
	{ action: 'resume', label: 'Resume', when: ['paused'] },
	{ action: 'restart', label: 'Restart', when: ['restartable', 'failed', 'stopped'] },
] as const satisfies readonly { action: string; label: string; when: readonly RunStatus[] }[]

/**
 * One run: its status, what it waits on with the forms that answer it, and its steps as bars. Live:
 * it refreshes on every change to the run.
 */
export const RunPage = component<RunPageOptions>({
	name: 'run-page',
	styles,
	onMount({ append, element, create, options, signal }) {
		const { id } = options
		const heading = element('h1', { textContent: `Run ${id}` })
		const facts = element('dl', { classes: styles.facts })
		const buttons = element('div', { classes: styles.actions })
		const status = element('p', { role: 'alert' })
		const waiting = element('section', { classes: styles.section })
		const steps = element('section', { classes: styles.section })
		const usage = element('section', { classes: styles.section })
		append(heading, facts, buttons, status, waiting, steps, usage)

		const opened = new Map<string, boolean>()
		const open: OpenState = {
			isOpen: (step, otherwise) => opened.get(step) ?? otherwise,
			remember: (step, isOpen) => {
				opened.set(step, isOpen)
			},
		}
		// The request forms stay as they are while the run waits on them, so a refresh doesn't clear what's typed.
		let shownRequests = ''

		const act = async (action: string) => {
			const answer: Answer<unknown> = await send('POST', `/engine/runs/${encodeURIComponent(id)}/${action}`, {}, RunRecord, signal)
			status.textContent = answer.ok ? '' : answer.error
			refresh()
		}

		const fact = (term: string, value: string) => [element('dt', { textContent: term }), element('dd', { textContent: value })]

		const showRecord = (record: RunRecord) => {
			facts.replaceChildren(
				...fact('Status', record.status),
				...fact('Workflow', record.workflow),
				...fact('App', `${record.app.name} ${record.app.version}`),
				...fact('Started by', `${record.trigger.kind} ${record.trigger.id}`),
				...fact('Started', shownTime(record.createdAt)),
				...fact('Last change', shownTime(record.updatedAt)),
				...(record.error === undefined ? [] : fact('Error', record.error)),
				...(record.reason === undefined ? [] : fact('Skipped', record.reason)),
			)
			buttons.replaceChildren(
				...actions
					.filter(({ when }) => (when as readonly RunStatus[]).includes(record.status))
					.map(({ action, label }) =>
						element('button', {
							type: 'button',
							textContent: label,
							on: {
								click() {
									void act(action)
								},
							},
						}),
					),
			)
			const requests = JSON.stringify(record.pending)
			if (requests !== shownRequests) {
				shownRequests = requests
				waiting.replaceChildren(
					...(record.pending.length === 0
						? []
						: [
								element('h2', { textContent: 'Waiting on' }),
								...record.pending.map((request) =>
									element('div', { classes: styles.waiting, children: create(RunRequestView, { run: id, request }) }),
								),
							]),
				)
			}
			usage.replaceChildren(
				...(record.usage === undefined
					? []
					: [
							element('h2', { textContent: 'Usage' }),
							element('table', {
								children: [
									element('thead', {
										children: element('tr', {
											children: ['Model', 'Requests', 'Input tokens', 'Output tokens', 'Cost (USD)'].map((label) =>
												element('th', { textContent: label }),
											),
										}),
									}),
									element('tbody', {
										children: Object.entries(record.usage).map(([model, used]) =>
											element('tr', {
												children: [model, used.requests, used.inputTokens, used.outputTokens, used.costUsd.toFixed(4)].map((value) =>
													element('td', { textContent: String(value) }),
												),
											}),
										),
									}),
								],
							}),
						]),
			)
		}

		const show = async (abortSignal: AbortSignal) => {
			const [record, events] = await Promise.all([
				read(`/engine/runs/${encodeURIComponent(id)}`, RunRecord, abortSignal),
				read(`/engine/runs/${encodeURIComponent(id)}/events`, z.array(RunEvent), abortSignal),
			])
			if (abortSignal.aborted) return
			if (!record.ok) {
				status.textContent = record.error
				return
			}
			showRecord(record.value)
			if (!events.ok) {
				steps.replaceChildren(element('p', { role: 'alert', textContent: events.error }))
				return
			}
			const bars = stepsOf(events.value, finished.has(record.value.status))
			steps.replaceChildren(
				element('h2', { textContent: 'Steps' }),
				...(bars.length === 0
					? [element('p', { textContent: 'No steps yet.' })]
					: bars.map((step, index) => create(StepBar, { step, latest: index === bars.length - 1, open }))),
			)
		}

		const refresh = refresher(show, signal)
		onChange((change) => {
			if (change.kind === 'all' || change.id === id) refresh()
		}, signal)
		refresh()
	},
})
