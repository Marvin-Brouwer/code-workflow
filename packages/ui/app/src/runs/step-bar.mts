import { component, cssClass, type CssClass } from '@rooted/components'
import { shownTime, statusLabel } from './run-labels.mts'
import type { Call, Step, StreamItem } from './run-steps.mts'
import styles from './step-bar.css'

/** Which bars and chips are open, kept across refreshes of the run, so a change doesn't close what someone opened. */
export interface OpenState {
	/** Whether `id` is open: as someone left it, or else `otherwise`. */
	readonly isOpen: (id: string, otherwise: boolean) => boolean
	readonly remember: (id: string, open: boolean) => void
}

export interface StepBarOptions {
	readonly step: Step
	/** Open unless someone closed it: the latest step. Failed steps are open too. */
	readonly latest: boolean
	readonly open: OpenState
}

/**
 * One step of a run as a bar: its title and status, and opened, what it did. A tool call shows its
 * input and result, an agent its text with its calls as chips that open their input and result, a
 * group its own steps as bars. Closed but for the latest and failed ones, so a long run reads as a
 * list of what happened.
 */
export const StepBar = component<StepBarOptions>({
	name: 'step-bar',
	styles,
	onMount({ append, element, create, options }) {
		const { step, latest, open } = options

		const detail = (label: string, value: unknown) =>
			value === undefined
				? undefined
				: element('pre', {
						classes: styles.detail,
						textContent: `${label}\n${typeof value === 'string' ? value : JSON.stringify(value, undefined, 2)}`,
					})

		const callDetails = (call: Call) => [detail('Input', call.input), detail('Result', call.result), detail('Error', call.error)]

		const remembered = (id: string, otherwise: boolean, classes: CssClass[], children: (HTMLElement | undefined)[]) => {
			const details = element('details', { classes, open: open.isOpen(id, otherwise), children })
			details.addEventListener('toggle', () => {
				open.remember(id, details.open)
			})
			return details
		}

		const chip = (call: Call, id: string) =>
			remembered(
				id,
				false,
				[styles.chip],
				[element('summary', { textContent: `${call.title} · ${statusLabel(call.status)}` }), ...callDetails(call)],
			)

		const streamItem = (item: StreamItem, index: number) => {
			if (item.kind === 'text') return element('p', { classes: styles.text, textContent: item.text })
			if (item.kind === 'note') return element('p', { classes: styles.note, textContent: item.text })
			return chip(item.call, `${step.id}/${String(index)}`)
		}

		const body = element('div', {
			classes: styles.body,
			children: [
				...(step.call === undefined ? [] : callDetails(step.call)),
				...step.stream.map(streamItem),
				...step.steps.map((inner, index) => create(StepBar, { step: inner, latest: index === step.steps.length - 1, open })),
			],
		})

		append(
			remembered(
				step.id,
				latest || step.status === 'failed',
				[styles.bar, cssClass(step.status === 'failed', styles.failed)],
				[
					element('summary', {
						children: [
							element('span', { classes: styles.title, textContent: step.title }),
							element('span', { classes: styles.meta, textContent: `${step.kind} · ${statusLabel(step.status)} · ${shownTime(step.at)}` }),
						],
					}),
					body,
				],
			),
		)
	},
})
