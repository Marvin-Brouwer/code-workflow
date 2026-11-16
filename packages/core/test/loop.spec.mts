import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { prompt } from '../src/agent/prompt.mts'
import { requestUserInput } from '../src/agent/request-user-input.mts'
import { check } from '../src/check/check.mts'
import { fail } from '../src/exits/fail.mts'
import { propose } from '../src/exits/propose.mts'
import { succeed } from '../src/exits/succeed.mts'
import { verify } from '../src/exits/verify.mts'
import { limit } from '../src/limit/limit.mts'
import { AgentGaveUp, ChecksFailed, ExitNotCalled, LoopLimitExceeded } from '../src/loop/loop-errors.mts'
import { toPrompt } from '../src/render/to-prompt.mts'
import { tool } from '../src/tool/tool.mts'
import { workspace } from '../src/workspace/workspace.mts'
import { runBody } from './support/run-body.mts'
import { asInRequest, callsTool, neverAnswers, says, scriptedModel, textOf } from './support/scripted-model.mts'

const Answer = z.object({ answer: z.number() })

/** A minutes limit the scripted model never comes near, but a human wait would use up: 300 ms. */
const budgetMinutes = 0.005
/** Longer than `budgetMinutes`. */
const humanWaitMs = 600
/** A minutes limit that's up while the model is still thinking: 120 ms. */
const tinyBudgetMinutes = 0.002
/** How long a stopped run may take to settle: the body's and the store's grace, with a margin. */
const promptlyMs = 3_000
/** The same, when a tool never settles, so closing the store takes its whole grace. */
const promptlyWithStuckToolMs = 3_500

/** How many timers the process has running. */
function timers(): number {
	return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
}

describe('loop', () => {
	test('resolves to the final text when the template has no exits', async () => {
		// Arrange
		const model = scriptedModel([says('Paris')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`What is the capital of France?`, model)

		// Assert
		expect(await run.result).toBe('Paris')
		expect(textOf(model.requests[0])).toContain('What is the capital of France?')
	})

	test('sends the template dedented, with values rendered in place', async () => {
		// Arrange
		const model = scriptedModel([says('ok')])
		const helper = agent({ model: model.id })
		const story = { key: 'ABC-1' }

		// Act
		const run = await runBody(
			() => helper.loop`
				Look at ${story}.
				    Then answer.
			`,
			model,
		)
		await run.result

		// Assert
		const user = model.requests[0]?.messages.find((message) => message.role === 'user')
		expect(user?.content).toBe('Look at {\n\t"key": "ABC-1"\n}.\n    Then answer.')
	})

	test('returns invalid exit data to the agent and resolves to the data that fits', async () => {
		// Arrange
		const model = scriptedModel([callsTool('succeed', { answer: 'forty-two' }), callsTool('succeed', { answer: 42 })])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Answer. ${succeed(Answer)}`, model)

		// Assert
		expect(await run.result).toEqual({ answer: 42 })
		expect(model.calls()).toBe(2)
	})

	test('rejects with the reason when the agent calls fail', async () => {
		// Arrange
		const model = scriptedModel([callsTool('fail', { reason: 'no story' })])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Plan it. ${succeed(Answer)} Or ${fail}.`, model)

		// Assert
		await expect(run.result).rejects.toThrow(AgentGaveUp)
		await expect(run.result).rejects.toMatchObject({ reason: 'no story' })
		expect((await run.outcome).status).toBe('failed')
	})

	test('runs a tool the agent calls and gives it the result', async () => {
		// Arrange
		const calls: string[] = []
		const search = tool('search', {
			input: z.object({ query: z.string() }),
			action: async ({ query }) => {
				calls.push(query)
				return { hits: 3 }
			},
		})
		const model = scriptedModel([callsTool('search', { query: 'login' }), says('three hits')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Search with ${search}.`, model)

		// Assert
		expect(await run.result).toBe('three hits')
		expect(calls).toEqual(['login'])
		expect(textOf(model.requests[1])).toContain('\\"hits\\": 3')
		expect(textOf(model.requests[0])).toContain('Search with `search`.')
	})

	test('fails the loop when a tool throws, instead of handing the error to the agent', async () => {
		// Arrange
		const broken = tool('broken', { input: z.object({}), action: () => Promise.reject(new Error('credential expired')) })
		const model = scriptedModel([callsTool('broken'), says('I will improvise')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Use ${broken}.`, model)

		// Assert
		await expect(run.result).rejects.toThrow('credential expired')
		expect(model.calls()).toBe(1)
	})

	test('fails the loop when a tool its action calls gets input that does not fit', async () => {
		// Arrange
		const lookup = tool('lookup', { input: z.object({ key: z.string() }), action: async ({ key }) => key })
		const wrapper = tool('wrapper', {
			input: z.object({}),
			// @ts-expect-error: a bug in the action, calling another tool with the wrong input
			action: () => lookup({ key: 42 }),
		})
		const model = scriptedModel([callsTool('wrapper'), says('I will improvise')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Use ${wrapper}.`, model)

		// Assert
		await expect(run.result).rejects.toThrow('The input of lookup')
		expect(model.calls()).toBe(1)
	})

	test('fails the loop when a check throws, instead of handing the error to the agent', async () => {
		// Arrange
		const tests = check('tests', () => Promise.reject(new Error('pipeline credential expired')))
		const model = scriptedModel([callsTool('verify'), callsTool('verify')])
		const developer = agent({ model: model.id })

		// Act
		const run = await runBody(() => developer.loop`Fix it, then ${verify(tests)}.`, model)

		// Assert
		await expect(run.result).rejects.toThrow('pipeline credential expired')
		expect(model.calls()).toBe(1)
	})

	test('hands verify findings back to the agent and finishes once the checks pass', async () => {
		// Arrange
		let attempt = 0
		const tests = check('tests', async () => (++attempt === 1 ? [{ source: 'tests', message: 'login test fails' }] : []))
		const model = scriptedModel([callsTool('verify'), callsTool('verify')])
		const developer = agent({ model: model.id })

		// Act
		const run = await runBody(() => developer.loop`Fix it, then hand in with ${verify(tests)}.`, model)

		// Assert
		expect(await run.result).toBeUndefined()
		expect(textOf(model.requests[1])).toContain('login test fails')
	})

	test('fails with the last findings after maxRejections', async () => {
		// Arrange
		const tests = check('tests', async () => [{ source: 'tests', message: 'still red' }])
		const model = scriptedModel([callsTool('verify'), callsTool('verify'), says('unreachable')])
		const developer = agent({ model: model.id })

		// Act
		const run = await runBody(() => developer.loop`Hand in with ${verify({ maxRejections: 2 }, tests)}.`, model)

		// Assert
		await expect(run.result).rejects.toThrow(ChecksFailed)
		expect(model.calls()).toBe(2)
	})

	test('runs the gate before succeed when both are in the template', async () => {
		// Arrange
		let ran = 0
		const tests = check('tests', async () => {
			ran++
			return []
		})
		const model = scriptedModel([callsTool('succeed', { answer: 1 })])
		const developer = agent({ model: model.id })

		// Act
		const run = await runBody(() => developer.loop`Work. ${verify(tests)} ${succeed(Answer)}`, model)

		// Assert
		expect(await run.result).toEqual({ answer: 1 })
		expect(ran).toBe(1)
		expect(textOf(model.requests[0])).toContain('the checks (tests), which run when you call `succeed`')
	})

	test('waits for a human on propose, returns the feedback, and resolves once approved', async () => {
		// Arrange
		const model = scriptedModel([callsTool('propose', { answer: 1 }), callsTool('propose', { answer: 2 })])
		const planner = agent({ model: model.id })

		// Act
		const run = await runBody(() => planner.loop`Propose with ${propose(Answer)}.`, model)
		const first = await run.channel.nextInput()
		run.channel.reply(first.id, { approved: false, feedback: 'too small' })
		const second = await run.channel.nextInput()
		run.channel.reply(second.id, { approved: true })

		// Assert
		expect(await run.result).toEqual({ answer: 2 })
		expect(first.question).toContain('"answer": 1')
		expect(textOf(model.requests[1])).toContain('too small')
	})

	test('lets the agent ask the user through a tool of its system prompt', async () => {
		// Arrange
		const model = scriptedModel([callsTool('requestUserInput', { question: 'Which repository?' }), says('done')])
		const planner = agent({ model: model.id, system: prompt`When unsure, ${requestUserInput}.` })

		// Act
		const run = await runBody(() => planner.loop`Plan it.`, model)
		const asked = await run.channel.nextInput()
		run.channel.reply(asked.id, { answer: 'web' })

		// Assert
		expect(await run.result).toBe('done')
		expect(asked.question).toBe('Which repository?')
		expect(textOf(model.requests[1])).toContain('web')
	})

	test('lets the agent ask the user with a form, with the same kinds of field as input', async () => {
		// Arrange
		const form = {
			question: 'Which release?',
			fields: { channel: { kind: 'choice', options: ['stable', 'beta'] }, tagged: { kind: 'yesNo' } },
		}
		const model = scriptedModel([callsTool('requestUserInput', form), says('ok')])
		const helper = agent({ model: model.id, system: prompt`Ask with ${requestUserInput}.` })

		// Act
		const run = await runBody(() => helper.loop`Release it.`, model)
		const asked = await run.channel.nextInput()
		run.channel.reply(asked.id, { channel: 'beta', tagged: false })
		await run.result

		// Assert
		expect(asked.fields).toMatchObject({ channel: { enum: ['stable', 'beta'] }, tagged: { type: 'boolean' } })
		expect(textOf(model.requests[1])).toContain('\\"channel\\": \\"beta\\"')
	})

	test('finishes with a folder once it holds enough files', async () => {
		// Arrange
		const Research = workspace.folder('research', { minFiles: 1 })
		let directory = ''
		const writesThenSucceeds: FauxResponseStep = async () => {
			await mkdir(path.join(directory, 'research'), { recursive: true })
			await writeFile(path.join(directory, 'research', 'overview.md'), '# Overview')
			return callsTool('succeed')
		}
		const model = scriptedModel([callsTool('succeed'), writesThenSucceeds])
		const planner = agent({ model: model.id })

		// Act
		const run = await runBody(() => planner.loop`Write to ${Research}, then ${succeed(Research)}.`, model)
		directory = run.workspace

		// Assert
		expect(await run.result).toBe(Research)
		// Absolute, so the agent still finds it after it has changed into a checkout.
		const research = `${path.join(run.workspace, 'research')}${path.sep}`
		expect(textOf(model.requests[0])).toContain(asInRequest(`${research}, empty so far`))
		expect(textOf(model.requests[1])).toContain(asInRequest(`${research} has 0 of the 1 files`))
	})

	test('renders a folder with a description as where it is on disk, what it holds and its files', async () => {
		// Arrange
		const notes = workspace.folder('notes', { description: 'one file per finding' })
		const model = scriptedModel([callsTool('succeed')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(async () => {
			await workspace.file('notes/overview.md').write('# Overview')
			await workspace.file('notes/risks.md').write('# Risks')
			return helper.loop`Read ${notes}, then ${succeed()}.`
		}, model)
		await run.result

		// Assert
		const directory = `${path.join(run.workspace, 'notes')}${path.sep}`
		expect(textOf(model.requests[0])).toContain(asInRequest(`Read ${directory} (one file per finding), with overview.md, risks.md, then`))
	})

	test('renders a workspace file as where it is on disk, so it is found from inside a checkout too', async () => {
		// Arrange
		const notes = workspace.file('notes/issue.md')
		const model = scriptedModel([callsTool('succeed')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Read ${notes}, then ${succeed()}.`, model)
		await run.result

		// Assert
		const located = path.join(run.workspace, 'notes', 'issue.md')
		expect(textOf(model.requests[0])).toContain(asInRequest(`Read ${located}, then`))
	})

	test('reminds the agent to call an exit, and fails after the reminders', async () => {
		// Arrange
		const model = scriptedModel([says('done?'), says('done?'), says('done?'), says('done?')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Work. ${succeed()}`, model)

		// Assert
		await expect(run.result).rejects.toThrow(ExitNotCalled)
		expect(model.calls()).toBe(4)
		expect(textOf(model.requests[1])).toContain('call `succeed`')
	})

	test('rejects when the loop goes over its turns', async () => {
		// Arrange
		const noop = tool('noop', { input: z.object({}), action: async () => 'ok' })
		const model = scriptedModel([callsTool('noop'), callsTool('noop'), callsTool('noop')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Use ${noop}. ${succeed()} ${limit({ turns: 2 })}`, model)

		// Assert
		await expect(run.result).rejects.toThrow(LoopLimitExceeded)
		expect(model.calls()).toBe(2)
		expect(textOf(model.requests[0])).toContain('You have at most 2 model turns for this task.')
	})

	test('rejects when the loop goes over its minutes, also while the model never answers', async () => {
		// Arrange
		const model = scriptedModel([neverAnswers])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Work. ${succeed()} ${limit({ minutes: tinyBudgetMinutes })}`, model)

		// Assert
		await expect(run.result).rejects.toMatchObject({ name: 'LoopLimitExceeded', limit: 'minutes' })
	})

	test('does not count time waiting on a human toward minutes', async () => {
		// Arrange
		const model = scriptedModel([callsTool('requestUserInput', { question: 'ok?' }), callsTool('succeed')])
		const helper = agent({ model: model.id })

		// Act
		const run = await runBody(() => helper.loop`Ask with ${requestUserInput}. ${succeed()} ${limit({ minutes: budgetMinutes })}`, model)
		const asked = await run.channel.nextInput()
		await new Promise((resolve) => setTimeout(resolve, humanWaitMs))
		run.channel.reply(asked.id, { answer: 'yes' })

		// Assert
		await expect(run.result).resolves.toBeUndefined()
	})

	test('does not count a human wait of an agent it called as a tool toward its minutes', async () => {
		// Arrange
		const model = scriptedModel([
			callsTool('changeCode', { task: 'rename x' }),
			callsTool('requestUserInput', { question: 'which x?' }),
			says('renamed'),
			callsTool('succeed'),
		])
		const developer = agent({ model: model.id, system: prompt`Ask with ${requestUserInput}.` })
		const reviewer = agent({ model: model.id })

		// Act
		const run = await runBody(
			() => reviewer.loop`Ask ${developer.as('changeCode')} for changes. ${succeed()} ${limit({ minutes: budgetMinutes })}`,
			model,
		)
		const asked = await run.channel.nextInput()
		await new Promise((resolve) => setTimeout(resolve, humanWaitMs))
		run.channel.reply(asked.id, { answer: 'the first one' })

		// Assert
		await expect(run.result).resolves.toBeUndefined()
	})

	test('stops a loop run in a check of a loop that went over its minutes', async () => {
		// Arrange
		const model = scriptedModel([callsTool('verify'), neverAnswers])
		const developer = agent({ model: model.id })
		const reviewer = agent({ model: model.id })
		const reviews: Promise<unknown>[] = []
		const codeReview = check('code review', async () => {
			const reviewing = reviewer.loop`Review it. ${succeed()}`
			reviews.push(reviewing)
			await reviewing
			return []
		})

		// Act
		const run = await runBody(() => developer.loop`Work, then ${verify(codeReview)}. ${limit({ minutes: tinyBudgetMinutes })}`, model)

		// Assert
		await expect(run.result).rejects.toMatchObject({ name: 'LoopLimitExceeded', limit: 'minutes' })
		expect(reviews).toHaveLength(1)
		await expect(reviews[0]).rejects.toMatchObject({ name: 'LoopLimitExceeded', limit: 'minutes' })
	})

	test('leaves no timer running when the loop fails before it starts', async () => {
		// Arrange
		const helper = agent({ model: 'no-such-model' })
		const before = timers()

		// Act
		const run = await runBody(() => helper.loop`Work. ${succeed()} ${limit({ minutes: 10 })}`, scriptedModel([]))
		await run.outcome

		// Assert
		await expect(run.result).rejects.toThrow('no-such-model')
		expect(timers()).toBeLessThanOrEqual(before)
	})
})

describe('loop keys', () => {
	test('go by call order when loops from one call site run concurrently', async () => {
		// Arrange
		const model = scriptedModel([says('one'), says('two')])
		const helper = agent({ model: model.id })
		const slowToRender = { [toPrompt]: () => new Promise<string>((resolve) => setTimeout(resolve, 50, 'first item')) }
		const items = [slowToRender, 'second item']

		// Act
		const run = await runBody(() => Promise.all(items.map((item) => helper.loop`Do ${item}.`)), model)
		await run.result

		// Assert
		const keys = run.channel.events.flatMap((event) => (event.type === 'loop' ? [[event.prompt, event.key]] : []))
		expect(keys).toEqual(
			expect.arrayContaining([
				['Do first item.', expect.stringMatching(/#1$/)],
				['Do second item.', expect.stringMatching(/#2$/)],
			]),
		)
	})
})

describe('agent.as', () => {
	test('runs a loop of the agent as a tool, with its checks as the gate', async () => {
		// Arrange
		const model = scriptedModel([callsTool('changeCode', { task: 'rename x' }), callsTool('verify'), says('changed')])
		let checked = 0
		const tests = check('tests', async () => {
			checked++
			return []
		})
		const developer = agent({ model: model.id })
		const reviewer = agent({ model: model.id })

		// Act
		const run = await runBody(() => reviewer.loop`Ask ${developer.as('changeCode', { in: 'the web repository', verify: [tests] })}.`, model)

		// Assert
		expect(await run.result).toBe('changed')
		expect(checked).toBe(1)
		expect(textOf(model.requests[1])).toContain('rename x\\n\\nWork in the web repository')
	})
})

describe('stopping a run', () => {
	test('settles promptly while the model never answers', async () => {
		// Arrange
		const model = scriptedModel([neverAnswers])
		const helper = agent({ model: model.id })
		const run = await runBody(() => helper.loop`Work.`, model)
		await expect.poll(() => model.calls()).toBe(1)

		// Act
		const started = Date.now()
		run.controller.abort(new Error('stop'))

		// Assert
		expect((await run.outcome).status).toBe('failed')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})

	test('settles promptly while a tool never settles and ignores its abort signal', async () => {
		// Arrange
		const stuck = tool('stuck', { input: z.object({}), action: () => new Promise<never>(() => {}) })
		const model = scriptedModel([callsTool('stuck')])
		const helper = agent({ model: model.id })
		const run = await runBody(() => helper.loop`Use ${stuck}.`, model)
		await expect.poll(() => run.channel.events.some((event) => event.type === 'tool-call')).toBe(true)

		// Act
		const started = Date.now()
		run.controller.abort(new Error('stop'))

		// Assert
		expect((await run.outcome).status).toBe('failed')
		expect(Date.now() - started).toBeLessThan(promptlyWithStuckToolMs)
	})

	test('settles promptly while waiting on a human', async () => {
		// Arrange
		const model = scriptedModel([callsTool('propose', { answer: 1 })])
		const planner = agent({ model: model.id })
		const run = await runBody(() => planner.loop`Propose with ${propose(Answer)}.`, model)
		await run.channel.nextInput()

		// Act
		run.controller.abort(new Error('stop'))

		// Assert
		expect(await run.outcome).toMatchObject({ status: 'failed' })
		expect(run.channel.messages.at(-1)).toEqual({ type: 'failed', error: 'stop' })
	})
})
