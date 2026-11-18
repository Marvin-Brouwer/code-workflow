import { PublicRegistry, servedPrefixLength } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { nugetOrg } from '../src/nuget-org.mts'

describe('nugetOrg', () => {
	test('is a public registry the build description takes', () => {
		// Act
		const parsed = PublicRegistry.safeParse(nugetOrg)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test.each([
		'/v3/index.json',
		'/v3-flatcontainer/newtonsoft.json/index.json',
		'/v3-vulnerabilities/index.json',
		'/v3-index/repository-signatures/5.0.0/index.json',
	])('serves what restore reads: %s', (path) => {
		// Act
		const served = servedPrefixLength(nugetOrg, path)

		// Assert
		expect(served).toBeDefined()
	})

	test.each(['/', '/api/v2/package/newtonsoft.json', '/packages/newtonsoft.json'])('serves nothing else on the host: %s', (path) => {
		// Act
		const served = servedPrefixLength(nugetOrg, path)

		// Assert
		expect(served).toBeUndefined()
	})
})
