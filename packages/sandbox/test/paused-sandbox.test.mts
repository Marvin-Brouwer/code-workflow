import { describe, expect, test } from 'vitest'
import { PausedSandbox } from '../src/paused-sandbox.mts'

const paused: PausedSandbox = {
	backend: 'gvisor',
	id: 'mesh-flow-0123456789ab',
	spec: { image: 'node:26-slim', cpus: 1, memoryMb: 1024, egress: { allow: [] } },
	snapshot: 'mhol3k2',
}

describe('PausedSandbox', () => {
	test('reads back what was written as JSON', () => {
		// Act
		const parsed = PausedSandbox.parse(JSON.parse(JSON.stringify(paused)))

		// Assert
		expect(parsed).toEqual(paused)
	})

	test('refuses a backend it does not know', () => {
		// Act
		const result = PausedSandbox.safeParse({ ...paused, backend: 'docker' })

		// Assert
		expect(result.success).toBe(false)
	})
})
