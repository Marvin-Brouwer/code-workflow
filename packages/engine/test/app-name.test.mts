import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { appNameOf } from '../src/cli/app-name.mts'

/** A directory with a `package.json` named `name`, removed when the test ends. */
async function packageNamed(name: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'app-name-'))
	onTestFinished(() => rm(directory, { recursive: true, force: true }))
	await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }))
	return directory
}

describe('appNameOf', () => {
	test("folds a package's scope into the app name", async () => {
		// Arrange
		const directory = await packageNamed('@example/big-repo')

		// Act
		const name = await appNameOf(directory, undefined)

		// Assert
		expect(name).toBe('example-big-repo')
	})

	test('takes an unscoped name as it is, and a given name over the package', async () => {
		// Arrange
		const directory = await packageNamed('workflows')

		// Act
		const unscoped = await appNameOf(directory, undefined)
		const given = await appNameOf(directory, 'team-workflows')

		// Assert
		expect(unscoped).toBe('workflows')
		expect(given).toBe('team-workflows')
	})
})
