import type { RunEvent, RunStatus } from '../_shared/runs.mts'

/**
 * Where a step is: still going (running, waiting or paused, as the run is), done, failed, or
 * interrupted: left without an end by an attempt that is over.
 */
export type StepStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'

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
 * - `poll`: looks at something outside until it changes, such as a pull request's review, folded
 *   into one bar for as long as nothing else happens;
 * - `group`: a node of `inDependencyOrder`, with its own steps as bars inside;
 * - `note`: anything else that happened, such as nodes that were blocked.
 */
export interface Step {
	readonly id: string
	readonly kind: 'tool' | 'agent' | 'input' | 'wait' | 'poll' | 'group' | 'note'
	readonly title: string
	readonly status: StepStatus
	readonly at: string
	readonly call: Call | undefined
	readonly steps: readonly Step[]
	readonly stream: readonly StreamItem[]
}

/** Event types that only frame others: their steps show at the level they're at. */
const framing = new Set(['workflow', 'in-dependency-order'])

/** One attempt of a run, which a restart adds: its steps, and whether it is the run's current one. */
export interface Attempt {
	/** The attempt's id, the part of its events' ids before the `-`. */
	readonly id: string
	readonly current: boolean
	readonly steps: readonly Step[]
}

/** The attempt an event belongs to: its id up to the first `-`, as the runtime numbers them. */
function attemptOf(event: RunEvent): string {
	return event.id.split('-', 1)[0] ?? event.id
}

/** Statuses in which none of a run's steps go on: it's over, or can only be restarted. */
const overStatuses: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'stopped', 'skipped', 'restartable'])

/**
 * The run's events by attempt, in the order the attempts ran. The current attempt is the one of the
 * latest event, unless the run is `starting`, as it is after a restart, before its new attempt sent
 * anything. A step without an end is interrupted, unless it's in the current attempt of a run that
 * isn't over.
 */
export function attemptsOf(events: readonly RunEvent[], status: RunStatus): Attempt[] {
	const byAttempt = Map.groupBy(events, attemptOf)
	const latest = events.at(-1)
	const current = latest === undefined || status === 'starting' ? undefined : attemptOf(latest)
	const over = overStatuses.has(status)
	return [...byAttempt].map(([id, attemptEvents]) => ({
		id,
		current: id === current,
		steps: stepsOf(attemptEvents, over || id !== current),
	}))
}

/**
 * The bars of one attempt from its event tree: a bar per tool call from code, per agent, per input
 * and wait, and per `inDependencyOrder` node with its own bars inside. In the order they started, so
 * steps that ran at once stack by start time. `over` says the attempt goes no further, so a step that
 * never ended is shown as interrupted, not as running.
 */
export function stepsOf(events: readonly RunEvent[], over: boolean): Step[] {
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
		return { status: over ? 'interrupted' : 'running', ended }
	}

	const callOf = (event: RunEvent, name: string): Call => {
		const { status, ended } = statusOf(event)
		const toolError = childrenOf(event).find(({ type }) => type === 'tool-error')
		// A coding tool's call is one event with its outcome on it; the others end in a child.
		const selfContained = ended === undefined && 'failed' in event
		const outcome = selfContained ? event : ended
		const error =
			textOf(toolError?.error) ?? textOf(ended?.error) ?? (selfContained && event.failed === true ? textOf(event.result) : undefined)
		return {
			title: textOf(outcome?.title) ?? name,
			status: callStatus({ selfContained, failed: event.failed === true, error, status }),
			input: event.input,
			result: error === undefined ? textOf(outcome?.result) : undefined,
			error,
		}
	}

	const streamOf = (loop: RunEvent): StreamItem[] =>
		childrenOf(loop).flatMap((event): StreamItem[] => {
			if (event.type === 'turn')
				return textOf(event.text) === undefined || textOf(event.text) === '' ? [] : [{ kind: 'text', text: String(event.text) }]
			if (event.type === 'tool-call') return [{ kind: 'call', call: callOf(event, textOf(event.tool) ?? 'tool') }]
			if (event.type === 'exit-call') return [{ kind: 'call', call: callOf(event, textOf(event.exit) ?? 'exit') }]
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
		foldedPolls(
			childrenOf(parent).flatMap((event): Step[] => {
				if (parent !== undefined && (event.type === `${parent.type}-succeeded` || event.type === `${parent.type}-failed`)) return []
				if (framing.has(event.type)) return stepsUnder(event)
				if (event.type === 'tool-call') {
					const call = callOf(event, textOf(event.tool) ?? 'tool')
					return [step(event, { kind: 'tool', title: call.title, status: call.status, call, steps: stepsUnder(event) })]
				}
				if (event.type === 'loop')
					return [step(event, { kind: 'agent', title: `Agent on ${modelText(event.model) ?? 'a model'}`, stream: streamOf(event) })]
				if (event.type === 'input') return [step(event, { kind: 'input', title: textOf(event.question) ?? 'A question' })]
				if (event.type === 'wait') return [step(event, { kind: 'wait', title: `Waits ${textOf(event.time) ?? ''}`.trim() })]
				if (event.type === 'node') return [step(event, { kind: 'group', title: textOf(event.node) ?? 'node', steps: stepsUnder(event) })]
				if (event.type === 'poll') {
					// What a look read is the same each time: only a failed look shows its calls, for the error.
					const { status } = statusOf(event)
					const title = `Waits for ${textOf(event.description) ?? 'a change'}`
					return [step(event, { kind: 'poll', title, status, steps: status === 'failed' ? stepsUnder(event) : [] })]
				}
				return [step(event, { kind: 'note', title: event.type, status: 'succeeded' })]
			}),
		)

	return stepsUnder(undefined)
}

/**
 * Polls next to each other that wait for the same thing, as one bar: it started with the first, and
 * is where the latest is, so it reads as waiting until something else happens.
 */
function foldedPolls(steps: readonly Step[]): Step[] {
	return steps.reduce<Step[]>((folded, current) => {
		const previous = folded.at(-1)
		if (current.kind !== 'poll' || previous?.kind !== 'poll' || previous.title !== current.title) return [...folded, current]
		return [...folded.slice(0, -1), { ...previous, status: current.status, steps: current.steps }]
	}, [])
}

/** A call's status: a self-contained call's from its `failed` flag, any other's from its end, failed when it has an error. */
function callStatus(call: { selfContained: boolean; failed: boolean; error: string | undefined; status: StepStatus }): StepStatus {
	if (call.selfContained) return call.failed ? 'failed' : 'succeeded'
	if (call.error !== undefined) return 'failed'
	return call.status
}

/** A field that is text, or `undefined`. */
function textOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

/** An agent's model as its loop names it: one model id, or several in the order they're tried. */
function modelText(value: unknown): string | undefined {
	if (Array.isArray(value)) return value.every((modelId) => typeof modelId === 'string') ? value.join(' or ') : undefined
	return textOf(value)
}
