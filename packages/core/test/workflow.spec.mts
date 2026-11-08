import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { agent } from '../src/agent/agent.mts'
import { tool } from '../src/tool/tool.mts'
import { runBody } from './support/run-body.mts'

describe('runWorkflow', () => {
	test('sends the event tree and succeeded', async () => {
		// Arrange
		const double = tool('double', { input: z.object({ n: z.number() }), action: async ({ n }) => n * 2 })

		// Act
		const run = await runBody(() => double({ n: 2 }))

		// Assert
		expect(await run.result).toBe(4)
		expect(await run.outcome).toEqual({ status: 'succeeded' })
		const [root, call] = run.channel.events
		expect(root).toMatchObject({ type: 'workflow', workflow: 'test' })
		expect(root?.parentId).toBeUndefined()
		expect(call).toMatchObject({ type: 'tool-call', tool: 'double', parentId: root?.id })
		expect(run.channel.messages.at(-1)).toEqual({ type: 'succeeded' })
	})

	test('sends failed with the error when the body throws', async () => {
		// Act
		const run = await runBody(() => Promise.reject(new Error('no story')))

		// Assert
		expect(await run.outcome).toMatchObject({ status: 'failed' })
		expect(run.channel.messages.at(-1)).toEqual({ type: 'failed', error: 'no story' })
		expect(run.channel.events.map((event) => event.type)).toEqual(['workflow', 'workflow-failed'])
	})

	test('fails a loop up front when the run has no model providers', async () => {
		// Arrange
		const helper = agent({ model: 'claude-opus-5-5' })

		// Act
		const run = await runBody(() => helper.loop`Hello`)

		// Assert
		await expect(run.result).rejects.toThrow('no model providers')
	})

	test('fails a loop whose model no provider offers', async () => {
		// Arrange
		const { scriptedModel } = await import('./support/scripted-model.mts')
		const model = scriptedModel([])
		const helper = agent({ model: 'claude-opus-5-5' })

		// Act
		const run = await runBody(() => helper.loop`Hello`, model)

		// Assert
		await expect(run.result).rejects.toThrow('No provider of this run offers model claude-opus-5-5')
	})
})
