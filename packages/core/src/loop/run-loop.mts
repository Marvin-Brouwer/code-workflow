import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
	AssistantEntry,
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
	type Conversation,
	type EntryId,
	type Extension,
	type SettledSubmissionRecord,
	type ToolRegistration,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { z } from 'zod'
import { promptParts, type Prompt } from '../agent/prompt.mts'
import type { ExitSpec } from '../exits/exit.mts'
import type { Endpoint } from '../gateway/gateway-client.mts'
import { emitEvent, inEvent } from '../run/run-events.mts'
import { currentScope, type Scope } from '../run/run-scope.mts'
import type { WorkspaceFolder } from '../workspace/workspace-folder.mts'
import type { AgentHarness, StoredResult } from './agent-harness.mts'
import { exitTools, verifyTool } from './exit-tools.mts'
import { startLoopClock } from './loop-clock.mts'
import { ExitNotCalled, LoopFailed, LoopLimitExceeded } from './loop-errors.mts'
import type { LoopOutcome, LoopSession, Stop } from './loop-session.mts'
import { exitName, readTemplate, uniqueTools, type LoopTemplate } from './loop-template.mts'
import { agentTool } from './loop-tools.mts'
import { runGateOf } from './run-gate.mts'

/** What a loop needs of its agent. */
export interface LoopAgent {
	readonly model: string
	readonly reasoning: 'low' | 'medium' | 'high' | undefined
	readonly system: Prompt | undefined
}

/** How often the agent is reminded to call an exit before the loop fails. */
const maxReminders = 3

/** For work that has to finish even when the loop's own signal is aborted, such as ending its run. */
const neverAborted = new AbortController().signal

/** Hex digits of a loop's fingerprint in its store key: enough that two inputs of one call site never meet. */
const fingerprintLength = 16

/**
 * Runs one loop: the agent works on the template until it calls an exit. One Pi Durable
 * conversation per loop, keyed by the call site, the names of the nodes around it and how often that
 * call site ran there.
 *
 * In the store, the key also holds a fingerprint of what the agent gets: model, reasoning, system
 * prompt and template, as rendered. A loop that finished in an earlier attempt with the same input
 * returns its kept result; a loop whose input changed, such as the next item of a list that grew,
 * starts over.
 */
export async function runLoop(
	agent: LoopAgent,
	parts: { strings: readonly string[]; values: readonly unknown[] },
	site: string,
): Promise<unknown> {
	const scope = currentScope('loop')
	// Counted before anything is awaited, so concurrent loops from one call site get their keys in call order.
	const base = [scope.run.workflow, site, ...scope.names].join(' ')
	const key = `${base} #${scope.run.count(`loop ${base}`)}`
	const template = await readTemplate(parts, 'loop')
	const system = agent.system === undefined ? undefined : await readTemplate(agent.system[promptParts], 'system')
	const storeKey = `${key} ${fingerprint(agent, system, template)}`
	return inEvent('loop', { model: agent.model, key, prompt: template.text }, async (loopScope) => {
		const harness = await loopScope.run.agents()
		const kept = await harness.keptResult(storeKey, loopScope.run.abortSignal)
		if (kept !== undefined) {
			emitEvent(loopScope, 'loop-kept')
			return keptValue(kept, template)
		}
		const result = await driveLoop({ agent, template, system, key, storeKey, scope: loopScope, harness })
		const stored = toStored(result, template)
		if (stored === undefined)
			emitEvent(loopScope, 'loop-not-kept', { reason: "JSON wouldn't give the result back unchanged, so a rerun runs the loop again." })
		else await harness.keepResult(storeKey, stored, loopScope.run.abortSignal)
		return result
	})
}

/** What the agent gets in a loop, in short: a different input never shares a conversation or a kept result. */
function fingerprint(agent: LoopAgent, system: LoopTemplate | undefined, template: LoopTemplate): string {
	const input = JSON.stringify([agent.model, agent.reasoning ?? null, system?.text ?? null, template.text])
	return createHash('sha256').update(input).digest('hex').slice(0, fingerprintLength)
}

interface DriveLoopInput {
	readonly agent: LoopAgent
	readonly template: LoopTemplate
	readonly system: LoopTemplate | undefined
	readonly key: string
	/** The key with the loop's fingerprint, for the store. */
	readonly storeKey: string
	readonly scope: Scope
	readonly harness: AgentHarness
}

async function driveLoop({ agent, template, system, key, storeKey, scope: eventScope, harness }: DriveLoopInput): Promise<unknown> {
	const { run } = eventScope
	const model = await harness.model(agent.model, run.abortSignal)
	const stopNow = new AbortController()
	// A loop run from a tool call of another stops with it, such as a review in a check whose loop ran
	// out of time. The other loop's signal stops with the run too.
	const stopped = eventScope.loop?.abortSignal ?? run.abortSignal
	const abortSignal = AbortSignal.any([stopped, stopNow.signal])
	const ended = loopEndSignals()
	let outcome: LoopOutcome | undefined
	let stop: Stop | undefined
	const finish = (value: LoopOutcome, how: Stop) => {
		// A later `now` still stops a round that an exit let finish: a used-up limit or a stopped run doesn't wait for it.
		if (how === 'now') stopNow.abort(value.kind === 'error' ? value.error : undefined)
		if (outcome !== undefined) return
		outcome = value
		stop = how
		ended.finished()
	}

	const { turns: maxTurns, minutes } = template.limit ?? {}
	const clock = startLoopClock(minutes, () => {
		finish({ kind: 'error', error: new LoopLimitExceeded('minutes', minutes ?? 0) }, 'now')
	})
	const onAbort = () => {
		finish({ kind: 'error', error: stopped.reason }, 'now')
	}
	stopped.addEventListener('abort', onAbort, { once: true })
	if (stopped.aborted) onAbort()
	let extension: Extension | undefined
	let endpoint: Endpoint | undefined
	let idle: Promise<unknown> = Promise.resolve()
	try {
		endpoint = await openLoopEndpoint(template, system, eventScope, abortSignal)
		// Every loop around this one stands still too while this one waits on a human.
		const clocks = [...(eventScope.loop?.clocks ?? []), clock]
		const scope: Scope = { ...eventScope, loop: { clocks, abortSignal, ...(endpoint === undefined ? {} : { endpoint }) } }
		const session: LoopSession = { scope, abortSignal, finish }
		const handIns = handInExits(template)
		const tools = loopTools(template, system, handIns, session)
		let turns = 0
		extension = loopExtension(storeKey, tools, scope, {
			turn: (message) => {
				turns++
				emitEvent(scope, 'turn', { turn: turns, text: textOf(message) })
			},
			roundDone: () => {
				if (outcome !== undefined) ended.roundDone()
			},
		})
		harness.install(extension)

		const context = harness.context(abortSignal)
		const conversation = await harness.conversation(
			storeKey,
			{
				model,
				thinkingLevel: agent.reasoning ?? null,
				extensions: [CodingTools, extension],
				instructions: system?.text ?? null,
				cwd: run.workspace,
				maxTurns: null,
			},
			abortSignal,
		)
		let content = template.text
		for (let reminder = 0; ; reminder++) {
			if (maxTurns !== undefined) {
				if (turns >= maxTurns) throw new LoopLimitExceeded('turns', maxTurns)
				await conversation.configure({ maxTurns: maxTurns - turns }, context)
			}
			// The attempt is in the id: a rerun's input is new, never the settled record of an earlier attempt.
			const requestId = `${key} ${run.attempt} input ${reminder}`
			const submission = await conversation.submit({ type: 'input', content, requestId }, context)
			const settled = submission.wait(context).then(
				(record) => ({ record }),
				(error: unknown) => ({ error }),
			)
			await Promise.race([settled, ended.whenFinished])
			if (outcome !== undefined) {
				const ending = await endRun(stop, settled, ended.whenRoundDone, conversation, harness)
				idle = ending.idle
				if (outcome.kind === 'error') throw outcome.error
				return outcome.value
			}
			const result = await settled
			if ('error' in result) throw result.error
			const answer = answerOf(result.record, maxTurns)
			if (handIns.length === 0 && template.gate === undefined) return await answerText(conversation, answer, context)
			if (reminder === maxReminders) throw new ExitNotCalled(exitNames(handIns), maxReminders)
			emitEvent(scope, 'reminder', { reminder: reminder + 1 })
			content = `You stopped without finishing the task. When the work is done, call ${exitNames(handIns)
				.map((name) => `\`${name}\``)
				.join(' or ')}.`
		}
	} finally {
		clock.stop()
		stopped.removeEventListener('abort', onAbort)
		const installed = extension
		if (installed !== undefined) {
			void idle.finally(() => {
				harness.uninstall(installed)
			})
		}
		const opened = endpoint
		const { gateway } = run
		if (opened !== undefined && gateway !== undefined) {
			// Once the conversation is done with the loop's tools: a call on a closed endpoint fails the run.
			const close = () => gateway.closeLoop(opened, run.abortSignal)
			void idle.then(close, close).catch(() => undefined)
		}
	}
}

/**
 * Opens a gateway endpoint for the loop's host tools, its own and its system prompt's, so the agent
 * can call those and no others. `undefined` when the loop has none.
 */
async function openLoopEndpoint(
	template: LoopTemplate,
	system: LoopTemplate | undefined,
	scope: Scope,
	abortSignal: AbortSignal,
): Promise<Endpoint | undefined> {
	const hostTools = uniqueTools([...(system?.tools ?? []), ...template.tools])
		.filter((spec) => spec.runsOnHost === true)
		.map((spec) => spec.name)
	if (hostTools.length === 0) return undefined
	const { gateway } = scope.run
	if (gateway === undefined) throw new Error(`${hostTools.join(', ')} run on the host, through the gateway, and this run has none.`)
	return gateway.openLoop(hostTools, abortSignal)
}

/** The agent's tools in a loop: its own and its system prompt's, the exits, and `verify` when that's the hand-in. */
function loopTools(
	template: LoopTemplate,
	system: LoopTemplate | undefined,
	handIns: readonly ExitSpec[],
	session: LoopSession,
): ToolRegistration[] {
	const gate = runGateOf(template.gate, session)
	const verifyHandIn =
		template.gate !== undefined && handIns.length === 0
			? [
					verifyTool(
						template.gate.checks.map((check) => check.name),
						gate,
						session,
					),
				]
			: []
	return [
		...uniqueTools([...(system?.tools ?? []), ...template.tools]).map((spec) => agentTool(spec, session)),
		...exitTools(template.exits, gate, session),
		...verifyHandIn,
	]
}

/** The loop's extension: its tools, and hooks that count turns, note round ends and emit coding tool calls. */
function loopExtension(
	storeKey: string,
	tools: readonly ToolRegistration[],
	scope: Scope,
	hooks: { readonly turn: (message: AssistantMessage) => void; readonly roundDone: () => void },
): Extension {
	const own = new Set(tools.map((registration) => registration.name))
	return defineExtension({
		// Named like the loop's conversation: stored work finds its own loop's tools, never another loop's.
		name: `mesh-flow.loop ${storeKey}`,
		tools,
		hooks: [
			hook(GenerationTask, {
				afterResponse: (message) => {
					if (message.stopReason !== 'error' && message.stopReason !== 'aborted') hooks.turn(message)
				},
				afterTools: hooks.roundDone,
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
}

/**
 * Ends the agent's run once the loop has its outcome. After an exit or a tool's throw, the current
 * tool round finishes first; a stopped run or a used-up limit stops it at once, without waiting for
 * work that may never settle. Resolves to a promise that settles once the conversation is done
 * with the loop's tools.
 */
async function endRun(
	stop: Stop | undefined,
	settled: Promise<unknown>,
	roundDone: Promise<undefined>,
	conversation: Conversation,
	harness: AgentHarness,
): Promise<{ readonly idle: Promise<void> }> {
	const submissionSettled = stop === 'round' && (await Promise.race([settled.then(() => true), roundDone.then(() => false)]))
	if (submissionSettled) return { idle: Promise.resolve() }
	// The run may go on with another request after the round, when the exit wasn't the only call.
	return { idle: conversation.abort(harness.context(neverAborted)).catch(() => undefined) }
}

/**
 * A loop's result as the store keeps it, or `undefined` when it can't be kept. Exit results come
 * from the agent's JSON arguments; a schema can still transform them into something JSON wouldn't
 * give back unchanged, such as a `bigint` or a `Date`.
 */
function toStored(result: unknown, template: LoopTemplate): StoredResult | undefined {
	const folder = folderOf(template)
	if (folder !== undefined && folder === result) return { folder: true }
	if (result === undefined) return {}
	try {
		const text = JSON.stringify(result) as string | undefined
		const parsed = text === undefined ? undefined : z.json().safeParse(JSON.parse(text))
		// Kept only when JSON gives back the same value: a `Date` would come back as a string, a `Map` as `{}`.
		return parsed?.success === true && isDeepStrictEqual(parsed.data, result) ? { value: parsed.data } : undefined
	} catch {
		return undefined
	}
}

/** A kept result as the loop returns it. */
function keptValue(kept: StoredResult, template: LoopTemplate): unknown {
	if ('folder' in kept) return folderOf(template)
	return kept.value
}

function folderOf(template: LoopTemplate): WorkspaceFolder | undefined {
	for (const spec of template.exits) if (spec.kind === 'succeed' && spec.folder !== undefined) return spec.folder
	return undefined
}

function answerOf(record: SettledSubmissionRecord, maxTurns: number | undefined): EntryId {
	if (record.status === 'done') {
		if (record.answer === undefined) throw new LoopFailed('no answer', undefined)
		return record.answer
	}
	if (record.reason === 'turn_limit') throw new LoopLimitExceeded('turns', maxTurns ?? 0)
	throw new LoopFailed(record.reason, record.detail)
}

async function answerText(conversation: Conversation, answer: EntryId, context: Context): Promise<string> {
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

/** The exits the agent finishes with: all but `fail`. */
function handInExits(template: LoopTemplate): readonly ExitSpec[] {
	return template.exits.filter((spec) => spec.kind !== 'fail')
}

/** What the agent is reminded to call: its hand-in exits, or `verify` when that's the hand-in. */
function exitNames(handIns: readonly ExitSpec[]): string[] {
	return handIns.length === 0 ? ['verify'] : handIns.map(exitName)
}

/** Two one-shot signals the loop waits on: an outcome was set, and the tool round after it is done. */
function loopEndSignals(): {
	readonly whenFinished: Promise<undefined>
	readonly whenRoundDone: Promise<undefined>
	readonly finished: () => void
	readonly roundDone: () => void
} {
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
