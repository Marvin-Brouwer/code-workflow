import type { RunEvent } from '../_shared/runs.mts'

/** Where a step is: still going, done, failed, or left unfinished by a run that ended. */
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'unfinished'

/** A call made by an agent or by code: what it was called with, and what came back. */
export interface Call {
	readonly title: string
	readonly status: StepStatus
	readonly input: unknown
	readonly result: string | undefined
	readonly error: string | undefined
}

/** What an agent's bar reads as, in order: its text, its calls as chips, and notes such as a reminder. */
export type StreamItem =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'call'; readonly call: Call }
	| { readonly kind: 'note'; readonly text: string }

/**
 * One bar of the run view:
 *
 * - `tool`: a tool called from code, titled by its `describe` line or its name;
 * - `agent`: an agent's loop, read as a stream of text and calls;
 * - `input`, `wait`: a question to a person, a wait until a time;
 * - `group`: a node of `inDependencyOrder`, with its own steps as bars inside;
 * - `note`: anything else that happened, such as nodes that were blocked.
 */
export interface Step {
	readonly id: string
	readonly kind: 'tool' | 'agent' | 'input' | 'wait' | 'group' | 'note'
	readonly title: string
	readonly status: StepStatus
	readonly at: string
	readonly call: Call | undefined
	readonly steps: readonly Step[]
	readonly stream: readonly StreamItem[]
}

/** Event types that only frame others: their steps show at the level they're at. */
const framing = new Set(['workflow', 'in-dependency-order'])

/**
 * The bars of a run from its event tree: a bar per tool call from code, per agent, per input and
 * wait, and per `inDependencyOrder` node with its own bars inside. In the order they started, so
 * steps that ran at once stack by start time. `finished` says the run is over, so a step that never
 * ended is shown as unfinished, not as running.
 */
export function stepsOf(events: readonly RunEvent[], finished: boolean): Step[] {
	const children = new Map<string | undefined, RunEvent[]>()
	const ids = new Set(events.map(({ id }) => id))
	for (const event of events) {
		const parent = event.parentId !== undefined && ids.has(event.parentId) ? event.parentId : undefined
		children.set(parent, [...(children.get(parent) ?? []), event])
	}
	const childrenOf = (event: RunEvent | undefined) => children.get(event?.id) ?? []

	const statusOf = (event: RunEvent): { status: StepStatus; ended: RunEvent | undefined } => {
		const ended = childrenOf(event).find(({ type }) => type === `${event.type}-succeeded` || type === `${event.type}-failed`)
		if (ended !== undefined) return { status: ended.type.endsWith('-failed') ? 'failed' : 'succeeded', ended }
		return { status: finished ? 'unfinished' : 'running', ended }
	}

	const callOf = (event: RunEvent, name: string): Call => {
		const { status, ended } = statusOf(event)
		const toolError = childrenOf(event).find(({ type }) => type === 'tool-error')
		// A coding tool's call is one event with its outcome on it; the others end in a child.
		const own = ended === undefined && 'failed' in event
		const outcome = own ? event : ended
		const error = text(toolError?.error) ?? text(ended?.error) ?? (own && event.failed === true ? text(event.result) : undefined)
		return {
			title: text(outcome?.title) ?? name,
			status: own ? (event.failed === true ? 'failed' : 'succeeded') : error === undefined ? status : 'failed',
			input: event.input,
			result: error === undefined ? text(outcome?.result) : undefined,
			error,
		}
	}

	const streamOf = (loop: RunEvent): StreamItem[] =>
		childrenOf(loop).flatMap((event): StreamItem[] => {
			if (event.type === 'turn')
				return text(event.text) === undefined || text(event.text) === '' ? [] : [{ kind: 'text', text: String(event.text) }]
			if (event.type === 'tool-call') return [{ kind: 'call', call: callOf(event, text(event.tool) ?? 'tool') }]
			if (event.type === 'exit-call') return [{ kind: 'call', call: callOf(event, text(event.exit) ?? 'exit') }]
			if (event.type === 'checks') return [{ kind: 'call', call: checksOf(event) }]
			if (event.type === 'reminder') return [{ kind: 'note', text: `Reminded to finish (${String(event.reminder)})` }]
			if (event.type === `${loop.type}-succeeded` || event.type === `${loop.type}-failed`) return []
			return [{ kind: 'note', text: event.type }]
		})

	const checksOf = (event: RunEvent): Call => {
		const { status } = statusOf(event)
		const rejected = childrenOf(event).find(({ type }) => type === 'checks-rejected')
		return {
			title: 'checks',
			status: rejected === undefined ? status : 'failed',
			input: event.checks,
			result: undefined,
			error: rejected === undefined ? undefined : JSON.stringify(rejected.findings ?? rejected.rejection, undefined, 2),
		}
	}

	const step = (event: RunEvent, fields: Pick<Step, 'kind' | 'title'> & Partial<Step>): Step => ({
		id: event.id,
		at: event.at,
		status: statusOf(event).status,
		call: undefined,
		steps: [],
		stream: [],
		...fields,
	})

	const stepsUnder = (parent: RunEvent | undefined): Step[] =>
		childrenOf(parent).flatMap((event): Step[] => {
			if (parent !== undefined && (event.type === `${parent.type}-succeeded` || event.type === `${parent.type}-failed`)) return []
			if (framing.has(event.type)) return stepsUnder(event)
			if (event.type === 'tool-call') {
				const call = callOf(event, text(event.tool) ?? 'tool')
				return [step(event, { kind: 'tool', title: call.title, status: call.status, call, steps: stepsUnder(event) })]
			}
			if (event.type === 'loop')
				return [step(event, { kind: 'agent', title: `Agent on ${text(event.model) ?? 'a model'}`, stream: streamOf(event) })]
			if (event.type === 'input') return [step(event, { kind: 'input', title: text(event.question) ?? 'A question' })]
			if (event.type === 'wait') return [step(event, { kind: 'wait', title: `Waits ${text(event.time) ?? ''}`.trim() })]
			if (event.type === 'node') return [step(event, { kind: 'group', title: text(event.node) ?? 'node', steps: stepsUnder(event) })]
			return [step(event, { kind: 'note', title: event.type, status: 'succeeded' })]
		})

	return stepsUnder(undefined)
}

/** A field that is text, or `undefined`. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}
