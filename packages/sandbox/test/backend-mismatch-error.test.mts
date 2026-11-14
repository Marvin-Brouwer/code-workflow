import { describe, expect, test } from 'vitest'
import { assertPausedBy, BackendMismatchError } from '../src/backend-mismatch-error.mts'
import type { BackendName } from '../src/backend-name.mts'
import type { PausedSandbox } from '../src/paused-sandbox.mts'

const paused: PausedSandbox = {
	backend: 'gvisor',
	id: 'mesh-flow-0123456789ab',
	spec: { image: 'node:26-slim', cpus: 1, memoryMb: 1024, egress: { allow: [] } },
	snapshot: 'mhol3k2',
}

describe('assertPausedBy', () => {
	test('accepts a pause made by the same backend', () => {
		// Arrange
		const backend: BackendName = 'gvisor'

		// Act
		const check = () => {
			assertPausedBy(paused, backend)
		}

		// Assert
		expect(check).not.toThrow()
	})

	test('refuses a pause made by another backend, naming both', () => {
		// Arrange
		const backend: BackendName = 'microsandbox'

		// Act
		const check = () => {
			assertPausedBy(paused, backend)
		}

		// Assert
		expect(check).toThrow(BackendMismatchError)
		expect(check).toThrow('This sandbox was paused by gvisor and can only be resumed there, not on microsandbox.')
	})
})
