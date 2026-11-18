import { describe, expect, test } from 'vitest'
import type { PublicRegistry } from '../src/package-registry.mts'
import { servedPrefixLength } from '../src/served-path.mts'

/** A registry with paths at two depths and an excluded path below one of them. */
const registry: PublicRegistry = {
	name: 'packages',
	host: 'packages.example.com',
	paths: ['/', '/feed/'],
	excludedPaths: ['/-/', '/feed/admin/'],
}

describe('servedPrefixLength', () => {
	test('is the length of the longest path a fetch is below', () => {
		// Act
		const lengths = [servedPrefixLength(registry, '/left-pad'), servedPrefixLength(registry, '/feed/left-pad')]

		// Assert
		expect(lengths).toEqual([1, '/feed/'.length])
	})

	test("doesn't take a path itself", () => {
		// Arrange
		const feedOnly: PublicRegistry = { ...registry, paths: ['/feed/'] }

		// Act
		const lengths = [servedPrefixLength(registry, '/'), servedPrefixLength(feedOnly, '/feed/')]

		// Assert
		expect(lengths).toEqual([undefined, undefined])
	})

	test.each([
		'/-/',
		'/-/whoami',
		'/feed/admin/users',
		'/%2D/whoami',
		'/%2d/v1/search',
		'/-%2Fwhoami',
		'/FEED/ADMIN/users',
		'/feed/Admin/users',
	])("doesn't take an excluded path, escaped or in another case either: %s", (path) => {
		// Act
		const length = servedPrefixLength(registry, path)

		// Assert
		expect(length).toBeUndefined()
	})

	test.each(['/left-pad/..%2F-%2Fwhoami', '/left-pad/%2E%2E/-/whoami', '/left-pad%5C..%5C-', '/left-pad%2F%2Fevil'])(
		"doesn't take a path that resolves elsewhere once decoded: %s",
		(path) => {
			// Act
			const length = servedPrefixLength(registry, path)

			// Assert
			expect(length).toBeUndefined()
		},
	)

	test('reads the path without its query, and keeps escapes servers keep, such as a scoped npm name', () => {
		// Act
		const lengths = [servedPrefixLength(registry, '/left-pad?text=/-/'), servedPrefixLength(registry, '/@types%2fnode')]

		// Assert
		expect(lengths).toEqual([1, 1])
	})
})
