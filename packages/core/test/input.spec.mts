import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { input } from '../src/workflow/input.mts'
import { runBody } from './support/run-body.mts'

describe('input', () => {
	test('asks with JSON Schema per field and resolves to the parsed answer', async () => {
		// Arrange
		const run = await runBody(() => input('Which story?', { key: z.string().regex(/^[A-Z]+-\d+$/) }))

		// Act
		const asked = await run.channel.nextInput()
		run.channel.reply(asked.id, { key: 'ABC-1' })

		// Assert
		expect(await run.result).toEqual({ key: 'ABC-1' })
		expect(asked).toMatchObject({ id: 'input-1', question: 'Which story?', fields: { key: { type: 'string' } } })
	})

	test('asks again, under a new id, when the answer does not fit', async () => {
		// Arrange
		const run = await runBody(() => input('How many?', { count: z.number() }))
		const first = await run.channel.nextInput()

		// Act
		run.channel.reply(first.id, { count: 'three' })
		const second = await run.channel.nextInput()
		run.channel.reply(second.id, { count: 3 })

		// Assert
		expect(await run.result).toEqual({ count: 3 })
		expect(second.id).toBe('input-2')
		expect(second.question).toContain("The last answer didn't fit")
	})

	test('asks a form of text, yes or no, a choice and several choices', async () => {
		// Arrange
		const run = await runBody(() =>
			input('How should the release go?', {
				notes: input.text('What changed'),
				tagged: input.yesNo(),
				channel: input.choice(['stable', 'beta']),
				platforms: input.choices(['web', 'ios', 'android']),
			}),
		)

		// Act
		const asked = await run.channel.nextInput()
		run.channel.reply(asked.id, { notes: 'Faster login', tagged: true, channel: 'beta', platforms: ['web', 'ios'] })

		// Assert
		expect(await run.result).toEqual({ notes: 'Faster login', tagged: true, channel: 'beta', platforms: ['web', 'ios'] })
		expect(asked.fields).toMatchObject({
			notes: { type: 'string', description: 'What changed' },
			tagged: { type: 'boolean' },
			channel: { enum: ['stable', 'beta'] },
			platforms: { type: 'array', items: { enum: ['web', 'ios', 'android'] } },
		})
	})
})
