import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { nativePackages } from '../src/native-packages.mts'
import { appRepository } from './support/app-repository.mts'

const abortSignal = new AbortController().signal

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
		const found = await nativePackages(directory, abortSignal)

		// Assert
		expect(found.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
			{ name: 'compiled', version: '1.0.0', buildsFromSource: true },
			{ name: 'inner', version: '1.0.0', buildsFromSource: true },
			{ name: 'platformed', version: '1.0.0', buildsFromSource: false },
			{ name: 'prebuilt', version: '1.0.0', buildsFromSource: false },
		])
	})

	test('follows a package to its real folder, so it finds dependencies pnpm puts next to it', async () => {
		// Arrange
		const directory = await appRepository({ packages: {} })
		await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'app', dependencies: { wrapper: '1.0.0' } }))
		const store = path.join(directory, 'node_modules', '.pnpm', 'wrapper@1.0.0', 'node_modules')
		await writePackage(path.join(store, 'wrapper'), { name: 'wrapper', version: '1.0.0', dependencies: { inner: '1.0.0' } })
		await writePackage(path.join(store, 'inner'), { name: 'inner', version: '1.0.0' })
		await mkdir(path.join(store, 'inner', 'prebuilds'))
		await symlink(path.join(store, 'wrapper'), path.join(directory, 'node_modules', 'wrapper'), 'junction')

		// Act
		const found = await nativePackages(directory, abortSignal)

		// Assert
		expect(found).toEqual([{ name: 'inner', version: '1.0.0', buildsFromSource: false }])
	})
})

async function writePackage(folder: string, json: Record<string, unknown>): Promise<void> {
	await mkdir(folder, { recursive: true })
	await writeFile(path.join(folder, 'package.json'), JSON.stringify(json))
}
