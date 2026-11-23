import { describe, expect, test } from 'vitest'
import type { RunEvent, RunRecord } from '../../app/src/_shared/runs.mts'
import { inListOrder } from '../../app/src/runs/run-labels.mts'
import { attemptsOf, stepsOf } from '../../app/src/runs/run-steps.mts'

const at = '2026-11-23T08:00:00.000Z'

/** An event of the tree as the runtime sends it. */
function event(id: string, type: string, parentId?: string, fields: Record<string, unknown> = {}): RunEvent {
	return { id, type, at, ...(parentId === undefined ? {} : { parentId }), ...fields }
}

/** A run that does a bit of everything: a tool call from code, an agent, a node, and a question. */
const events: RunEvent[] = [
	event('1-1', 'workflow', undefined, { workflow: 'fix-issue' }),
	event('1-2', 'tool-call', '1-1', { tool: 'githubIssue', from: 'code', input: { number: 63 } }),
	event('1-3', 'tool-call-succeeded', '1-2', { result: '{"title":"Dice"}', title: 'Collected issue #63' }),
	event('1-4', 'loop', '1-1', { model: 'claude-sonnet-5-5', prompt: 'Fix it' }),
	event('1-5', 'turn', '1-4', { turn: 1, text: 'Looking at the dice.' }),
	event('1-6', 'tool-call', '1-4', { tool: 'bash', from: 'agent', input: { command: 'ls' }, failed: true, result: 'ls: no such file' }),
	event('1-7', 'tool-call', '1-4', { tool: 'requestUserInput', from: 'agent', input: { question: 'Which?' } }),
	event('1-8', 'tool-call-succeeded', '1-7', { result: 'the red one' }),
	event('1-9', 'exit-call', '1-4', { exit: 'succeed', input: { summary: 'Fixed' } }),
	event('1-10', 'exit-call-succeeded', '1-9'),
	event('1-11', 'loop-succeeded', '1-4'),
	event('1-12', 'in-dependency-order', '1-1', { nodes: [{ id: 'api', dependsOn: [] }] }),
	event('1-13', 'node', '1-12', { node: 'api' }),
	event('1-14', 'tool-call', '1-13', { tool: 'gitPush', from: 'code', input: {} }),
	event('1-15', 'tool-call-failed', '1-14', { error: 'Push refused' }),
	event('1-16', 'node-failed', '1-13', { error: 'Push refused' }),
	event('1-17', 'input', '1-1', { question: 'Merge it?' }),
]

describe('stepsOf', () => {
	test('gives a bar per tool call from code, agent, node and question, in the order they started', () => {
		// Act
		const steps = stepsOf(events, false)

		// Assert
		expect(steps.map(({ kind, title, status }) => [kind, title, status])).toEqual([
			['tool', 'Collected issue #63', 'succeeded'],
			['agent', 'Agent on claude-sonnet-5-5', 'succeeded'],
			['group', 'api', 'failed'],
			['input', 'Merge it?', 'running'],
		])
	})

	test("reads an agent's bar as its text with its calls as chips", () => {
		// Act
		const agent = stepsOf(events, false)[1]

		// Assert
		expect(agent?.stream).toEqual([
			{ kind: 'text', text: 'Looking at the dice.' },
			{
				kind: 'call',
				call: { title: 'bash', status: 'failed', input: { command: 'ls' }, result: undefined, error: 'ls: no such file' },
			},
			{
				kind: 'call',
				call: { title: 'requestUserInput', status: 'succeeded', input: { question: 'Which?' }, result: 'the red one', error: undefined },
			},
			{ kind: 'call', call: { title: 'succeed', status: 'succeeded', input: { summary: 'Fixed' }, result: undefined, error: undefined } },
		])
	})

	test("puts a node's own steps inside its bar, with their errors", () => {
		// Act
		const node = stepsOf(events, false)[2]

		// Assert
		expect(node?.steps.map(({ title, status, call }) => [title, status, call?.error])).toEqual([['gitPush', 'failed', 'Push refused']])
	})

	test('shows a step that never ended as interrupted once the attempt is over', () => {
		// Act
		const steps = stepsOf(events, true)

		// Assert
		expect(steps.at(-1)?.status).toBe('interrupted')
	})
})

describe('attemptsOf', () => {
	/** A run that was restarted: its first attempt stopped while it asked, its second asks again. */
	const restarted: RunEvent[] = [
		event('a1-1', 'workflow', undefined, { workflow: 'fix-issue' }),
		event('a1-2', 'input', 'a1-1', { question: 'Merge it?' }),
		event('b2-1', 'workflow', undefined, { workflow: 'fix-issue' }),
		event('b2-2', 'input', 'b2-1', { question: 'Merge it?' }),
	]

	test("groups the steps by attempt, with the latest event's attempt as the current one", () => {
		// Act
		const attempts = attemptsOf(restarted, false)

		// Assert
		expect(attempts.map(({ id, current, steps }) => [id, current, steps.map(({ status }) => status)])).toEqual([
			['a1', false, ['interrupted']],
			['b2', true, ['running']],
		])
	})

	test('shows the open steps of a restartable or finished run as interrupted', () => {
		// Act
		const attempts = attemptsOf(restarted, true)

		// Assert
		expect(attempts.flatMap(({ steps }) => steps.map(({ status }) => status))).toEqual(['interrupted', 'interrupted'])
	})
})

/** A run record with what the list orders by. */
function record(id: string, updatedAt: string, pending: RunRecord['pending'] = []): RunRecord {
	return {
		id,
		workflow: 'fix-issue',
		trigger: { kind: 'user', id: 'fix-issue' },
		app: { name: 'github-issue', version: '1' },
		status: 'running',
		pending,
		createdAt: at,
		updatedAt,
	}
}

describe('inListOrder', () => {
	test('puts the runs that need someone first, then the latest change first', () => {
		// Arrange
		const records = [
			record('run-000000000001', '2026-11-23T08:01:00.000Z'),
			record('run-000000000002', '2026-11-23T08:00:00.000Z', [{ kind: 'login', id: 'login-1', connector: 'aws' }]),
			record('run-000000000003', '2026-11-23T08:02:00.000Z', [{ kind: 'wake', id: 'wake-1', at }]),
		]

		// Act
		const ordered = inListOrder(records)

		// Assert
		expect(ordered.map(({ id }) => id)).toEqual(['run-000000000002', 'run-000000000003', 'run-000000000001'])
	})
})
