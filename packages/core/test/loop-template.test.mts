import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { prompt } from '../src/agent/prompt.mts'
import { check } from '../src/check/check.mts'
import { fail } from '../src/exits/fail.mts'
import { propose } from '../src/exits/propose.mts'
import { succeed } from '../src/exits/succeed.mts'
import { verify } from '../src/exits/verify.mts'
import { limit } from '../src/limit/limit.mts'
import { readTemplate } from '../src/loop/loop-template.mts'
import { toPrompt } from '../src/render/to-prompt.mts'
import { tool } from '../src/tool/tool.mts'

const parts = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values })
const search = tool('search', { input: z.object({}), action: async () => [] })
const tests = check('tests', async () => [])

describe('readTemplate', () => {
	test('renders tools and exits by name and collects them', async () => {
		// Act
		const template = await readTemplate(parts`Use ${search}, then ${succeed()}, or ${fail}.`, 'loop')

		// Assert
		expect(template.text).toBe('Use `search`, then `succeed`, or `fail`.')
		expect(template.tools.map((spec) => spec.name)).toEqual(['search'])
		expect(template.exits.map((spec) => spec.kind)).toEqual(['succeed', 'fail'])
	})

	test('renders values that render themselves, and nested prompts with their tools', async () => {
		// Arrange
		const story = { [toPrompt]: () => 'stories/ABC-1.md' }
		const shared = prompt`Search with ${search}.`

		// Act
		const template = await readTemplate(parts`Read ${story}. ${shared}`, 'loop')

		// Assert
		expect(template.text).toBe('Read stories/ABC-1.md. Search with `search`.')
		expect(template.tools).toHaveLength(1)
	})

	test('renders verify as the hand-in alone, and as the gate next to propose', async () => {
		// Act
		const alone = await readTemplate(parts`Hand in with ${verify(tests)}.`, 'loop')
		const gate = await readTemplate(parts`${verify(tests)} ${propose(z.object({}))}`, 'loop')

		// Assert
		expect(alone.text).toBe('Hand in with `verify`.')
		expect(gate.text).toBe('the checks (tests), which run when you call `propose` `propose`')
	})

	test('renders the limit as a line and keeps it', async () => {
		// Act
		const template = await readTemplate(parts`Work. ${limit({ turns: 4, minutes: 20 })}`, 'loop')

		// Assert
		expect(template.text).toBe('Work. You have at most 4 model turns and 20 minutes of work for this task.')
		expect(template.limit).toEqual({ turns: 4, minutes: 20 })
	})

	test.each([
		['two limits', parts`${limit({ turns: 1 })} ${limit({ turns: 2 })}`, 'one limit'],
		[
			'two different tools with one name',
			parts`${search} ${tool('search', { input: z.object({}), action: async () => [] })}`,
			'Two different tools',
		],
		['a tool named like an exit', parts`${tool('succeed', { input: z.object({}), action: async () => [] })} ${succeed()}`, 'like the exit'],
	])('refuses %s', async (_name, template, message) => {
		// Act
		const reading = readTemplate(template, 'loop')

		// Assert
		await expect(reading).rejects.toThrow(message)
	})

	test('refuses exits in a system prompt', async () => {
		// Act
		const reading = readTemplate(parts`${succeed()}`, 'system')

		// Assert
		await expect(reading).rejects.toThrow('belong in a loop')
	})
})
