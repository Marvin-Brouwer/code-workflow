import { component } from '@rooted/components'
import { z } from 'zod'
import { read, send, type Answer } from '../_shared/api.mts'
import { followStream } from '../_shared/follow-stream.mts'
import { refresher } from '../_shared/refresher.mts'
import { RunEvent, RunRecord, type RunStatus } from '../_shared/runs.mts'
import { RunFacts } from './run-facts.mts'
import { RunRequestView } from './run-requests.mts'
import { RunUsage } from './run-usage.mts'
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
 * it follows the run's own stream, and fetches it every two seconds while that stream is down.
 */
export const RunPage = component<RunPageOptions>({
	name: 'run-page',
	styles,
	onMount({ append, element, create, options, signal }) {
		const { id } = options
		const heading = element('h1', {
			textContent: `Run ${id}`,
		})
		const facts = element('div')
		const buttons = element('div', {
			classes: styles.actions,
		})
		const status = element('p', {
			role: 'alert',
		})
		const waiting = element('section', {
			classes: styles.section,
		})
		const steps = element('section', {
			classes: styles.section,
		})
		const usage = element('section', {
			classes: styles.section,
		})
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
		}

		const showRecord = (record: RunRecord) => {
			facts.replaceChildren(
				create(RunFacts, {
					record,
				}),
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
								element('h2', {
									textContent: 'Waiting on',
								}),
								...record.pending.map((request) =>
									element('div', {
										classes: styles.waiting,
										children: create(RunRequestView, {
											run: id,
											request,
										}),
									}),
								),
							]),
				)
			}
			usage.replaceChildren(
				...(record.usage === undefined
					? []
					: [
							create(RunUsage, {
								usage: record.usage,
							}),
						]),
			)
		}

		const showSteps = (record: RunRecord, events: readonly RunEvent[]) => {
			const bars = stepsOf(events, finished.has(record.status))
			steps.replaceChildren(
				element('h2', {
					textContent: 'Steps',
				}),
				...(bars.length === 0
					? [
							element('p', {
								textContent: 'No steps yet.',
							}),
						]
					: bars.map((step, index) =>
							create(StepBar, {
								step,
								latest: index === bars.length - 1,
								open,
							}),
						)),
			)
		}

		// What the run's stream sent so far, drawn once for each burst of it.
		let record: RunRecord | undefined
		let events: RunEvent[] = []
		let drawing = false
		const draw = () => {
			if (drawing) return
			drawing = true
			queueMicrotask(() => {
				drawing = false
				if (record === undefined || signal.aborted) return
				showRecord(record)
				showSteps(record, events)
			})
		}

		// While the stream is down: the same, fetched.
		const fetchRun = async (abortSignal: AbortSignal) => {
			const [fetchedRecord, fetchedEvents] = await Promise.all([
				read(`/engine/runs/${encodeURIComponent(id)}`, RunRecord, abortSignal),
				read(`/engine/runs/${encodeURIComponent(id)}/events`, z.array(RunEvent), abortSignal),
			])
			if (abortSignal.aborted) return
			if (!fetchedRecord.ok) {
				status.textContent = fetchedRecord.error
				return
			}
			if (!fetchedEvents.ok) {
				status.textContent = fetchedEvents.error
				return
			}
			record = fetchedRecord.value
			events = fetchedEvents.value
			draw()
		}

		followStream(`/api/engine/runs/${encodeURIComponent(id)}/events`, {
			on: {
				run: (data) => {
					const sent = RunRecord.safeParse(data)
					if (!sent.success) return
					record = sent.data
					draw()
				},
				event: (data) => {
					const sent = RunEvent.safeParse(data)
					if (!sent.success) return
					events.push(sent.data)
					draw()
				},
			},
			connected: () => {
				events = []
			},
			whileDown: refresher(fetchRun, signal),
			abortSignal: signal,
		})
	},
})
