import { describe, expect, test } from 'vitest'
import { agent, definedModels } from '../src/agent/agent.mts'

describe('definedModels', () => {
	test("lists each agent's models once, in the order they're tried, for a trigger to check before a run", () => {
		// Arrange
		agent({ model: 'model-b' })
		agent({ model: 'model-a' })
		agent({ model: 'model-b', reasoning: 'high' })
		agent({ model: ['model-c', 'model-a'] })

		// Act
		const models = definedModels()

		// Assert
		expect(models).toEqual([['model-a'], ['model-b'], ['model-c', 'model-a']])
	})
})
