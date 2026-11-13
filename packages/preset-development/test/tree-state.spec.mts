import type * as fsPromises from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { treeState } from '../src/review/tree-state.mts'
import { gitCheckout } from './support/git-checkout.mts'

/** The file a build makes and removes again while the state is taken. */
const fleeting = 'obj.tmp'

vi.mock('node:fs/promises', async (actual) => {
	const fs = await actual<typeof fsPromises>()
	return {
		...fs,
		lstat: async (entry: string) => {
			if (entry.endsWith(fleeting)) throw Object.assign(new Error(`ENOENT: no such file, lstat '${entry}'`), { code: 'ENOENT' })
			return fs.lstat(entry)
		},
	}
})

describe('treeState', () => {
	test('takes an untracked file that is gone by the time it is read as not there', async () => {
		// Arrange
		const repository = await gitCheckout()
		const abortSignal = AbortSignal.timeout(10_000)
		const without = await treeState(repository.directory, repository.defaultBranch, abortSignal)
		await writeFile(path.join(repository.directory, fleeting), 'made by the build')

		// Act
		const withFleeting = await treeState(repository.directory, repository.defaultBranch, abortSignal)

		// Assert
		expect(withFleeting).toBe(without)
	})
})
