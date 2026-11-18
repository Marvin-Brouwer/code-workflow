import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PackageRequest } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { openPackageCache } from '../src/packages/package-cache.mts'
import { npmRegistry } from './support/registries.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

const tarball: PackageRequest = { registry: npmRegistry, path: '/left-pad/-/left-pad-1.3.0.tgz' }
const fetched = { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('tarball') }

/** The files the cache in `directory` holds, wherever they are below it. */
async function filesIn(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true })
	return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

describe('openPackageCache', () => {
	test('keeps a package that was fetched whole, and not a version list', async () => {
		// Arrange
		const cache = openPackageCache(await temporaryDirectory())
		const versions: PackageRequest = { registry: npmRegistry, path: '/left-pad' }

		// Act
		await cache.put(tarball, fetched, abortSignal)
		await cache.put(versions, fetched, abortSignal)

		// Assert
		expect(await cache.get(tarball, abortSignal)).toEqual(fetched)
		expect(await cache.get(versions, abortSignal)).toBeUndefined()
	})

	test('takes an entry it cannot read for a miss, and writes it anew', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const cache = openPackageCache(directory)
		await cache.put(tarball, fetched, abortSignal)
		for (const file of await filesIn(directory)) if (file.endsWith('.json')) await writeFile(file, '{ "content-type": ')

		// Act
		const damaged = await cache.get(tarball, abortSignal)
		await cache.put(tarball, fetched, abortSignal)

		// Assert
		expect(damaged).toBeUndefined()
		expect(await cache.get(tarball, abortSignal)).toEqual(fetched)
	})

	test('still resolves when it cannot keep a package', async () => {
		// Arrange
		const parent = await temporaryDirectory()
		const directory = path.join(parent, 'packages')
		// A file where the cache's folder should be: nothing can be written below it.
		await rm(directory, { recursive: true, force: true })
		await writeFile(directory, 'not a folder')
		const cache = openPackageCache(directory)

		// Act
		const keeping = cache.put(tarball, fetched, abortSignal)

		// Assert
		await expect(keeping).resolves.toBeUndefined()
		expect(await cache.get(tarball, abortSignal)).toBeUndefined()
	})
})
