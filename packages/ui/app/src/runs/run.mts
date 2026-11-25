import { choice, component } from '@rooted/components'
import { z } from 'zod'
import { read, send, type Answer } from '../_shared/api.mts'
import { followStream } from '../_shared/follow-stream.mts'
import { announce, withOwnStream } from '../_shared/live-events.mts'
import { refresher } from '../_shared/refresher.mts'
import { RunEvent, RunRecord, type RunStatus } from '../_shared/runs.mts'
import { followBottom } from './follow-bottom.mts'
import { RunFacts } from './run-facts.mts'
import { runFeed } from './run-feed.mts'
import { RunRequestView } from './run-requests.mts'
import { attemptsOf, type Attempt, type Step } from './run-steps.mts'
import { RunUsage } from './run-usage.mts'
import { StepBar, type OpenState } from './step-bar.mts'
import styles from './run.css'

/** Which run the page shows. */
export interface RunPageOptions {
	readonly id: string
}

/** What a person can do to a run from its page, as the engine's routes of those names. */
type RunAction = 'stop' | 'resume' | 'restart'

/** What can be done to a run, and in which statuses the engine takes it. */
const actions: readonly { readonly action: RunAction; readonly label: string; readonly when: readonly RunStatus[] }[] = [
	{ action: 'stop', label: 'Stop', when: ['starting', 'running', 'paused', 'restartable'] },
	{ action: 'resume', label: 'Resume', when: ['paused'] },
	{ action: 'restart', label: 'Restart', when: ['restartable', 'failed', 'stopped'] },
]

/**
 * One run: its status, what it waits on with the forms that answer it, and its steps as bars, by
 * attempt. Live: it follows the run's own stream, in place of the engine's (see `withOwnStream`),
 * and fetches the run every `pollInterval` while that stream is down.
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

		const act = async (action: RunAction) => {
			const answer: Answer<unknown> = await send('POST', `/engine/runs/${encodeURIComponent(id)}/${action}`, {}, RunRecord, signal)
			status.textContent = answer.ok ? '' : answer.error
		}

		const waitingView = (record: RunRecord): HTMLElement[] => {
			if (record.pending.length === 0) return []
			return [
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
			]
		}

		const usageView = (record: RunRecord): HTMLElement[] => {
			if (record.usage === undefined) return []
			return [
				create(RunUsage, {
					usage: record.usage,
				}),
			]
		}

		const barsView = (bars: readonly Step[]): HTMLElement[] =>
			bars.map((step, index) =>
				create(StepBar, {
					step,
					latest: index === bars.length - 1,
					open,
				}),
			)

		const stepsView = (attempts: readonly Attempt[]): HTMLElement[] => {
			if (attempts.length === 0)
				return [
					element('p', {
						textContent: 'No steps yet.',
					}),
				]
			const [only] = attempts
			if (attempts.length === 1 && only !== undefined) return barsView(only.steps)
			return attempts.flatMap((attempt, index) => [
				element('h3', {
					textContent: `Attempt ${String(index + 1)}${choice(attempt.current, ', the current one', '')}`,
				}),
				...barsView(attempt.steps),
			])
		}

		const showRecord = (record: RunRecord) => {
			facts.replaceChildren(
				create(RunFacts, {
					record,
				}),
			)
			buttons.replaceChildren(
				...actions
					.filter(({ when }) => when.includes(record.status))
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
				waiting.replaceChildren(...waitingView(record))
			}
			usage.replaceChildren(...usageView(record))
		}

		const showSteps = (record: RunRecord, events: readonly RunEvent[]) => {
			steps.replaceChildren(
				element('h2', {
					textContent: 'Steps',
				}),
				...stepsView(attemptsOf(events, record.status)),
			)
		}

		// What the run's stream sent so far, drawn once for each burst of it, with the newest steps in view.
		const feed = runFeed()
		const follow = followBottom(signal)
		let drawing = false
		const draw = () => {
			if (drawing) return
			drawing = true
			queueMicrotask(() => {
				drawing = false
				const { record, events } = feed.snapshot()
				if (record === undefined || signal.aborted) return
				showRecord(record)
				showSteps(record, events)
				follow()
			})
		}

		// While the stream is down: the same, fetched.
		const fetchRun = async (abortSignal: AbortSignal) => {
			const started = feed.fetchStarted()
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
			if (feed.fetched(started, { record: fetchedRecord.value, events: fetchedEvents.value })) draw()
		}

		const refreshRun = refresher(fetchRun, signal)
		withOwnStream(signal)
		followStream(`/api/engine/runs/${encodeURIComponent(id)}/events`, {
			on: {
				run: (data) => {
					const sent = RunRecord.safeParse(data)
					if (!sent.success) return
					feed.streamedRecord(sent.data)
					draw()
				},
				'run-event': (data) => {
					const sent = RunEvent.safeParse(data)
					if (!sent.success) return
					feed.streamedEvent(sent.data)
					draw()
				},
				'sign-in': (data) => {
					const sent = z.object({ connector: z.string() }).safeParse(data)
					announce(sent.success ? { kind: 'sign-in', connector: sent.data.connector } : { kind: 'all' })
				},
			},
			connected: () => {
				feed.connected()
				announce({ kind: 'all' })
			},
			whileDown: () => {
				refreshRun()
				announce({ kind: 'all' })
			},
			abortSignal: signal,
		})
	},
})
