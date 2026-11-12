import { Script } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { forwarderEnv, forwarderReadyCheck, forwarderService } from '../../src/gvisor/egress-forwarder.mts'
import { egressMountPoint } from '../../src/gvisor/layout.mts'

describe('forwarderService', () => {
	test('is a script node can run, that connects to the egress socket', () => {
		// Arrange
		const [program, flag, source = ''] = forwarderService

		// Act
		const compile = () => new Script(source)

		// Assert
		expect([program, flag]).toEqual(['node', '-e'])
		expect(compile).not.toThrow()
		expect(source).toContain(`"${egressMountPoint}/egress.sock"`)
	})
})

describe('forwarderReadyCheck', () => {
	test('is a script node can run, that waits for the port the proxy variables name', () => {
		// Arrange
		const [program, flag, source = ''] = forwarderReadyCheck
		const proxy = new URL(forwarderEnv.HTTPS_PROXY ?? '')

		// Act
		const compile = () => new Script(source)

		// Assert
		expect([program, flag]).toEqual(['node', '-e'])
		expect(compile).not.toThrow()
		expect(source).toContain(`${JSON.stringify(proxy.hostname)}, ${proxy.port}`)
	})
})
