import { describe, expect, test } from 'vitest'
import { rootfsDirectory } from '../../src/gvisor/rootfs.mts'

describe('rootfsDirectory', () => {
	test('gives images that sanitise to the same name their own directory', () => {
		// Act
		const tagged = rootfsDirectory('/images', 'node:22-slim')
		const underscored = rootfsDirectory('/images', 'node_22-slim')

		// Assert
		expect(tagged).not.toBe(underscored)
	})
})
