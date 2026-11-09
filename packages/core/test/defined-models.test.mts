import { describe, expect, test } from 'vitest'
import { agent, definedModels } from '../src/agent/agent.mts'

describe('definedModels', () => {
	test("lists each agent's model once, for a trigger to check before a run", () => {
		// Arrange
		agent({ model: 'model-b' })
		agent({ model: 'model-a' })
		agent({ model: 'model-b', reasoning: 'high' })

		// Act
		const models = definedModels()

		// Assert
		expect(models).toEqual(['model-a', 'model-b'])
	})
})
