import { describe, expect, test } from 'vitest'
import { assertSandboxId, isSandboxId, newSandboxId, sandboxIdLength } from '../src/sandbox-id.mts'

describe('sandbox ids', () => {
	test('a new id is recognised as one, and has the documented length', () => {
		// Act
		const id = newSandboxId()

		// Assert
		expect(isSandboxId(id)).toBe(true)
		expect(id).toHaveLength(sandboxIdLength)
	})

	test.each(['../../etc', 'mesh-flow-0123456789ab/..', 'other-0123456789ab', ''])('refuses %j', (id) => {
		// Act
		const check = () => {
			assertSandboxId(id)
		}

		// Assert
		expect(check).toThrow("isn't a mesh-flow sandbox id")
	})
})
