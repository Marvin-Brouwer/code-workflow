import { describe, expect, test } from 'vitest'
import { sandboxIdOfSnapshot, snapshotName } from '../../src/microsandbox/snapshots.mts'
import { newSandboxId } from '../../src/sandbox-id.mts'

describe('microsandbox snapshot names', () => {
	test('lead back to the sandbox they were taken of', () => {
		// Arrange
		const id = newSandboxId()

		// Act
		const owner = sandboxIdOfSnapshot(snapshotName(id))

		// Assert
		expect(owner).toBe(id)
	})

	test.each([null, 'wait-1730000000', 'mesh-flow-0123456789ab', 'mesh-flow-0123456789abc-x'])(
		'belong to no sandbox when named %j',
		(name) => {
			// Act
			const owner = sandboxIdOfSnapshot(name)

			// Assert
			expect(owner).toBeUndefined()
		},
	)
})
