import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { openConnectorSettings } from '../src/connectors/connector-settings.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

describe('openConnectorSettings', () => {
	test('lists what was added, once each, and forgets what was removed', async () => {
		// Arrange
		const settings = openConnectorSettings(path.join(await temporaryDirectory(), 'connectors.json'))

		// Act
		await settings.add('@mesh-flow/github', abortSignal)
		await settings.add('@mesh-flow/github', abortSignal)
		await settings.add('gitlab-tools', abortSignal)
		const removed = await settings.remove('gitlab-tools', abortSignal)
		const removedAgain = await settings.remove('gitlab-tools', abortSignal)

		// Assert
		expect(await settings.list(abortSignal)).toEqual([{ package: '@mesh-flow/github' }])
		expect(removed).toBe(true)
		expect(removedAgain).toBe(false)
	})

	test('refuses what is not a package name', async () => {
		// Arrange
		const settings = openConnectorSettings(path.join(await temporaryDirectory(), 'connectors.json'))

		// Act
		const added = settings.add('../outside', abortSignal)

		// Assert
		await expect(added).rejects.toThrow('npm package name')
		expect(await settings.list(abortSignal)).toEqual([])
	})
})
