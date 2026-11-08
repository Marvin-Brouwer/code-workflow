import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
	AssistantEntry,
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
	type Conversation,
	type EntryId,
	type SettledSubmissionRecord,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { promptParts, type Prompt } from '../agent/prompt.mts'
import { emitEvent, inEvent } from '../run/run-events.mts'
import { currentScope, type Scope } from '../run/run-scope.mts'
import type { ToolSpec } from '../tool/tool.mts'
import type { AgentHarness } from './agent-harness.mts'
import { exitTools, verifyTool } from './exit-tools.mts'
import { gateOf } from './gate.mts'
import { startLoopClock } from './loop-clock.mts'
import { ExitNotCalled, LoopFailed, LoopLimitExceeded } from './loop-errors.mts'
import type { LoopOutcome, LoopSession, Stop } from './loop-session.mts'
import { exitName, readTemplate, type LoopTemplate } from './loop-template.mts'
import { agentTool } from './loop-tools.mts'

/** What a loop needs of its agent. */
export interface LoopAgent {
	readonly model: string
	readonly reasoning: 'low' | 'medium' | 'high' | undefined
	readonly system: Prompt | undefined
}

/** How often the agent is reminded to call an exit before the loop fails. */
const maxReminders = 3

/**
 * Runs one loop: the agent works on the template until it calls an exit. One Pi Durable
 * conversation per loop, keyed by the call site, the names of the nodes around it and how often that
 * call site ran there.
 */
export async function runLoop(
	agent: LoopAgent,
	parts: { strings: readonly string[]; values: readonly unknown[] },
	site: string,
): Promise<unknown> {
	const scope = currentScope('loop')
	const template = await readTemplate(parts, 'loop')
	const system = agent.system === undefined ? undefined : await readTemplate(agent.system[promptParts], 'system')
	const base = [scope.run.workflow, site, ...scope.names].join(' ')
	const key = `${base} #${scope.run.count(`loop ${base}`)}`
	return inEvent('loop', { model: agent.model, key, prompt: template.text }, async (loopScope) =>
		driveLoop({ agent, template, system, key, scope: loopScope, harness: await loopScope.run.agents() }),
	)
}

interface LoopRun {
	readonly agent: LoopAgent
	readonly template: LoopTemplate
	readonly system: LoopTemplate | undefined
	readonly key: string
	readonly scope: Scope
	readonly harness: AgentHarness
}

async function driveLoop({ agent, template, system, key, scope: eventScope, harness }: LoopRun): Promise<unknown> {
	const { run } = eventScope
	const stopNow = new AbortController()
	const signal = AbortSignal.any([run.signal, stopNow.signal])
	const ended = signals()
	let outcome: LoopOutcome | undefined
	let stop: Stop | undefined
	const finish = (value: LoopOutcome, how: Stop) => {
		if (outcome !== undefined) return
		outcome = value
		stop = how
		if (how === 'now') stopNow.abort(value.kind === 'error' ? value.error : undefined)
		ended.finished()
	}

	const { turns: maxTurns, minutes } = template.limit ?? {}
	const clock = startLoopClock(minutes, () => {
		finish({ kind: 'error', error: new LoopLimitExceeded('minutes', minutes ?? 0) }, 'now')
	})
	const scope: Scope = { ...eventScope, loop: { clock } }
	const session: LoopSession = { scope, signal, finish }
	const gate = gateOf(template.gate, session)
	const handIns = template.exits.filter((spec) => spec.kind !== 'fail')
	const tools = [
		...combine(system?.tools ?? [], template.tools).map((spec) => agentTool(spec, session)),
		...exitTools(template.exits, gate, session),
		...(template.gate !== undefined && handIns.length === 0
			? [
					verifyTool(
						template.gate.checks.map((check) => check.name),
						gate,
						session,
					),
				]
			: []),
	]
	const own = new Set(tools.map((registration) => registration.name))
	let turns = 0
	const extension = defineExtension({
		name: `mesh-flow.loop-${run.count('loop extension')}`,
		tools,
		hooks: [
			hook(GenerationTask, {
				afterResponse: (message) => {
					if (message.stopReason === 'error' || message.stopReason === 'aborted') return
					turns++
					emitEvent(scope, 'turn', { turn: turns, text: textOf(message) })
				},
				afterTools: () => {
					if (outcome !== undefined) ended.roundDone()
				},
			}),
			hook(ToolTask, {
				// The loop's own tools have their own events; this covers the coding tools.
				afterTool: (call, result) => {
					if (!own.has(call.name))
						emitEvent(scope, 'tool-call', { tool: call.name, from: 'agent', input: call.arguments, failed: result.isError === true })
					return undefined
				},
			}),
		],
	})
	harness.install(extension)

	const context = harness.context(signal)
	const conversation = await harness.conversation(
		key,
		{
			model: harness.model(agent.model),
			thinkingLevel: agent.reasoning ?? null,
			extensions: [CodingTools, extension],
			instructions: system?.text ?? null,
			cwd: run.workspace,
			maxTurns: null,
		},
		signal,
	)
	const onAbort = () => {
		finish({ kind: 'error', error: run.signal.reason }, 'now')
	}
	run.signal.addEventListener('abort', onAbort, { once: true })
	try {
		let content = template.text
		for (let reminder = 0; ; reminder++) {
			if (maxTurns !== undefined) {
				if (turns >= maxTurns) throw new LoopLimitExceeded('turns', maxTurns)
				await conversation.configure({ maxTurns: maxTurns - turns }, context)
			}
			const submission = await conversation.submit({ type: 'input', content, requestId: `${key} input ${reminder}` }, context)
			const settled = submission.wait(context).then(
				(record) => ({ record }),
				(error: unknown) => ({ error }),
			)
			await Promise.race([settled, ended.whenFinished])
			if (outcome !== undefined) return await conclude(outcome, stop, settled, ended.whenRoundDone, conversation, harness)
			const result = await settled
			if ('error' in result) throw result.error
			const answer = answerOf(result.record, maxTurns)
			if (handIns.length === 0 && template.gate === undefined) return await answerText(conversation, answer, context)
			if (reminder === maxReminders) throw new ExitNotCalled(exitNames(template), maxReminders)
			emitEvent(scope, 'reminder', { reminder: reminder + 1 })
			content = `You stopped without finishing the task. When the work is done, call ${exitNames(template)
				.map((name) => `\`${name}\``)
				.join(' or ')}.`
		}
	} finally {
		clock.stop()
		run.signal.removeEventListener('abort', onAbort)
	}
}

/**
 * Ends the agent's run for an outcome and returns the result or throws the error. After an exit or
 * a tool's throw, the current tool round finishes first; a stopped run or a used-up limit stops it
 * at once, without waiting for work that may never settle.
 */
async function conclude(
	outcome: LoopOutcome,
	stop: Stop | undefined,
	settled: Promise<unknown>,
	roundDone: Promise<undefined>,
	conversation: Conversation,
	harness: AgentHarness,
): Promise<unknown> {
	const runEnded = stop === 'round' && (await Promise.race([settled.then(() => true), roundDone.then(() => false)]))
	// The run may have gone on with another request after the round, when the exit wasn't the only call.
	if (!runEnded) void conversation.abort(harness.context(new AbortController().signal)).catch(() => undefined)
	if (outcome.kind === 'error') throw outcome.error
	return outcome.value
}

function answerOf(record: SettledSubmissionRecord, maxTurns: number | undefined): EntryId {
	if (record.status === 'done') {
		if (record.answer === undefined) throw new LoopFailed('no answer', undefined)
		return record.answer
	}
	if (record.reason === 'turn_limit') throw new LoopLimitExceeded('turns', maxTurns ?? 0)
	throw new LoopFailed(record.reason, record.detail)
}

async function answerText(conversation: Conversation, answer: EntryId, context: ReturnType<AgentHarness['context']>): Promise<string> {
	const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answer), context)
	const message = entry?.model?.[0]
	return message?.role === 'assistant' ? textOf(message) : ''
}

function textOf(message: AssistantMessage): string {
	return message.content
		.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join('')
		.trim()
}

function exitNames(template: LoopTemplate): string[] {
	const handIns = template.exits.filter((spec) => spec.kind !== 'fail').map(exitName)
	return handIns.length === 0 ? ['verify'] : handIns
}

/** The agent's system tools and the loop's, once each. */
function combine(system: readonly ToolSpec[], loop: readonly ToolSpec[]): ToolSpec[] {
	const byName = new Map<string, ToolSpec>()
	for (const spec of [...system, ...loop]) {
		const known = byName.get(spec.name)
		if (known !== undefined && known !== spec)
			throw new Error(`Two different tools are named ${spec.name} in this loop and its agent's system prompt: rename one.`)
		byName.set(spec.name, spec)
	}
	return [...byName.values()]
}

/** Two one-shot signals the loop waits on: an outcome was set, and the tool round after it is done. */
function signals() {
	const finished = Promise.withResolvers<undefined>()
	const roundDone = Promise.withResolvers<undefined>()
	return {
		whenFinished: finished.promise,
		whenRoundDone: roundDone.promise,
		finished: () => {
			finished.resolve(undefined)
		},
		roundDone: () => {
			roundDone.resolve(undefined)
		},
	}
}
