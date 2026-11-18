import { describe, expect, test } from 'vitest'
import { PackageRegistry, registryKey, servedPrefixLength, uniqueRegistries } from '../src/package-registry.mts'
import type { ConnectorRegistry, PublicRegistry } from '../src/package-registry.mts'

/** A registry with paths at two depths and an excluded path below one of them. */
const registry: PublicRegistry = {
	name: 'packages',
	host: 'packages.example.com',
	paths: ['/', '/feed/'],
	excludedPaths: ['/-/', '/feed/admin/'],
}

/** A connector's registry on the same host. */
const connectorRegistry: ConnectorRegistry = {
	connector: 'cloud',
	name: 'cloud packages',
	host: 'packages.example.com',
	paths: ['/'],
	settings: { repository: 'packages', domain: 'example' },
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

describe('registryKey', () => {
	test('is the same however the fields and their lists are ordered', () => {
		// Arrange
		const reordered: PublicRegistry = {
			excludedPaths: ['/feed/admin/', '/-/'],
			paths: ['/feed/', '/'],
			host: registry.host,
			name: registry.name,
		}

		// Act
		const keys = [registryKey(registry), registryKey(reordered)]

		// Assert
		expect(keys[0]).toBe(keys[1])
	})

	test("differs for a registry that reaches more: one that excludes less, or a connector's on the same paths", () => {
		// Arrange
		const widened: PublicRegistry = { ...registry, excludedPaths: [] }
		const publicOnConnectorPaths: PublicRegistry = { name: 'cloud packages', host: connectorRegistry.host, paths: ['/'] }

		// Act
		const keys = new Set([registryKey(registry), registryKey(widened), registryKey(connectorRegistry), registryKey(publicOnConnectorPaths)])

		// Assert
		expect(keys.size).toBe(4)
	})
})

describe('uniqueRegistries', () => {
	test('keeps the first of each registry, where it first comes', () => {
		// Arrange
		const renamed: PublicRegistry = { ...registry, name: 'packages again' }

		// Act
		const unique = uniqueRegistries([registry, connectorRegistry, renamed])

		// Assert
		expect(unique).toEqual([registry, connectorRegistry])
	})
})

describe('PackageRegistry', () => {
	test.each([
		['a public registry with a connector', { ...registry, connector: 'cloud' }],
		['a connector registry without settings', { connector: 'cloud', name: 'cloud', host: 'packages.example.com', paths: ['/'] }],
		['a registry with a field of its own', { ...registry, token: 'secret' }],
		['a path with a dot segment', { ...registry, excludedPaths: ['/../'] }],
	])('refuses %s', (_what, value) => {
		// Act
		const parsed = PackageRegistry.safeParse(value)

		// Assert
		expect(parsed.success).toBe(false)
	})

	test('takes each kind as itself', () => {
		// Act
		const parsed = [PackageRegistry.parse(registry), PackageRegistry.parse(connectorRegistry)]

		// Assert
		expect(parsed).toEqual([registry, connectorRegistry])
	})
})
