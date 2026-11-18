import { PublicRegistry, servedPrefixLength } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { npmRegistry } from '../src/npm-registry.mts'

describe('npmRegistry', () => {
	test('is a public registry the build description takes', () => {
		// Act
		const parsed = PublicRegistry.safeParse(npmRegistry)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test.each(['/zod', '/@types%2fnode', '/zod/-/zod-4.1.0.tgz', '/@types/node/-/node-26.6.6.tgz'])(
		'serves package documents and tarballs: %s',
		(path) => {
			// Act
			const served = servedPrefixLength(npmRegistry, path)

			// Assert
			expect(served).toBeDefined()
		},
	)

	test.each(['/-/v1/search?text=zod', '/-/npm/v1/security/advisories/bulk', '/-/whoami'])(
		"doesn't serve the registry's own API: %s",
		(path) => {
			// Act
			const served = servedPrefixLength(npmRegistry, path)

			// Assert
			expect(served).toBeUndefined()
		},
	)
})
