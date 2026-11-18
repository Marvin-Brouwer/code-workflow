import { describe, expect, test } from 'vitest'
import { PackageRegistry, registryKey, uniqueRegistries, type ConnectorRegistry, type PublicRegistry } from '../src/package-registry.mts'

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
		const registries = [registry, widened, connectorRegistry, publicOnConnectorPaths]

		// Act
		const keys = new Set(registries.map(registryKey))

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
