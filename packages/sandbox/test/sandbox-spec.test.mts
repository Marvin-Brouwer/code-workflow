import { describe, expect, test } from 'vitest'
import { EgressHost } from '../src/sandbox-spec.mts'

describe('EgressHost', () => {
	test.each(['registry.npmjs.org', 'gateway', 'api-1.example.com'])('accepts %s', (host) => {
		// Act
		const result = EgressHost.safeParse(host)

		// Assert
		expect(result.success).toBe(true)
	})

	test.each([
		'*.npmjs.org',
		'0.0.0.0/0',
		'1.2.3.4',
		'0x7f000001',
		'0x7f.1',
		'Registry.npmjs.org',
		'registry.npmjs.org:443',
		'registry.npmjs.org.',
		'',
	])('refuses %j', (host) => {
		// Act
		const result = EgressHost.safeParse(host)

		// Assert
		expect(result.success).toBe(false)
	})
})
