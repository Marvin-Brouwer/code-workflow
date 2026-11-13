import type * as fsPromises from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { gitCommand } from '@mesh-flow/git'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { treeState } from '../src/review/tree-state.mts'
import { gitCheckout } from './support/git-checkout.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** The file a build makes and removes again while the state is taken. */
const fleeting = 'obj.tmp'

/** Long enough for git on a busy runner. */
const stateTimeoutMs = 10_000

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
		const abortSignal = AbortSignal.timeout(stateTimeoutMs)
		const without = await treeState(repository.directory, repository.defaultBranch, { abortSignal })
		await writeFile(path.join(repository.directory, fleeting), 'made by the build')

		// Act
		const withFleeting = await treeState(repository.directory, repository.defaultBranch, { abortSignal })

		// Assert
		expect(withFleeting).toBe(without)
	})

	test('stays the same when the default branch moves on after the branch started', async () => {
		// Arrange
		const repository = await gitCheckout()
		const abortSignal = AbortSignal.timeout(stateTimeoutMs)
		const git = async (...args: string[]) => gitCommand(args, { cwd: repository.directory, abortSignal })
		const commit = async (message: string) =>
			git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--all', '--message', message)
		await git('switch', '--quiet', '--create', 'feature/KEY-1')
		await writeFile(path.join(repository.directory, 'README.md'), '# api\n\nThe change.\n')
		await commit('The change')
		const before = await treeState(repository.directory, repository.defaultBranch, { abortSignal })
		await git('switch', '--quiet', 'main')
		await writeFile(path.join(repository.directory, 'CHANGELOG.md'), 'Merged since.\n')
		await git('add', 'CHANGELOG.md')
		await commit('Merged since')
		await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
		await git('switch', '--quiet', 'feature/KEY-1')

		// Act
		const after = await treeState(repository.directory, repository.defaultBranch, { abortSignal })

		// Assert
		expect(after).toBe(before)
	})

	test('changes with a file outside the checkout that is part of the state', async () => {
		// Arrange
		const repository = await gitCheckout()
		const abortSignal = AbortSignal.timeout(stateTimeoutMs)
		const recorded = path.join(await temporaryDirectory(), 'plan-deviations.md')
		const without = await treeState(repository.directory, repository.defaultBranch, { abortSignal, files: [recorded] })
		await writeFile(recorded, '# Deviations from the plan\n')

		// Act
		const withDeviation = await treeState(repository.directory, repository.defaultBranch, { abortSignal, files: [recorded] })

		// Assert
		expect(withDeviation).not.toBe(without)
	})
})
