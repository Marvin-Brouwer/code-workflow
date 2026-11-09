import { describe, expect, test } from 'vitest'
import { nativePackages } from '../src/native-packages.mts'
import { appRepository } from './support/app-repository.mts'

describe('nativePackages', () => {
	test('finds packages with an addon, prebuilt binaries or platform packages, also when not direct, and nothing else', async () => {
		// Arrange
		const directory = await appRepository({
			packages: {
				compiled: { json: { gypfile: true } },
				prebuilt: { files: { 'prebuilds/linux-x64/addon.node': '' } },
				platformed: { json: { optionalDependencies: { 'platformed-linux-x64': '1.0.0' } } },
				wrapper: { json: { dependencies: { inner: '1.0.0' } } },
				inner: { files: { 'binding.gyp': '{}' } },
				plain: {},
			},
		})

		// Act
		const found = await nativePackages(directory, AbortSignal.timeout(10_000))

		// Assert
		expect(found.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
			{ name: 'compiled', version: '1.0.0', buildsFromSource: true },
			{ name: 'inner', version: '1.0.0', buildsFromSource: true },
			{ name: 'platformed', version: '1.0.0', buildsFromSource: false },
			{ name: 'prebuilt', version: '1.0.0', buildsFromSource: false },
		])
	})
})
