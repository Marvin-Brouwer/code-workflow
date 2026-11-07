import { Script } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { forwarderInit } from '../../src/gvisor/egress-forwarder.mts'
import { egressMountPoint } from '../../src/gvisor/layout.mts'

describe('forwarderInit', () => {
	test('is a script node can run, that connects to the egress socket', () => {
		// Arrange
		const [program, flag, source = ''] = forwarderInit

		// Act
		const compile = () => new Script(source)

		// Assert
		expect([program, flag]).toEqual(['node', '-e'])
		expect(compile).not.toThrow()
		expect(source).toContain(`"${egressMountPoint}/egress.sock"`)
	})
})
