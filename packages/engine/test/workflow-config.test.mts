import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { entryFile, findEntry, loadWorkflowConfig, workflowConfigFile } from '../src/workflow/workflow-config.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const sandbox = { image: 'node:22-slim', cpus: 2, memoryMb: 2048, egress: { allow: ['registry.npmjs.org'] } }

describe('loadWorkflowConfig', () => {
	test('fills in the defaults', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(path.join(directory, workflowConfigFile), JSON.stringify({ sandbox, start: ['node'] }))

		// Act
		const config = await loadWorkflowConfig(directory)

		// Assert
		expect(config).toEqual({ sandbox, setup: [], start: ['node'], entry: 'main.mts' })
	})

	test('says what is wrong with a bad config', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(
			path.join(directory, workflowConfigFile),
			JSON.stringify({ sandbox: { ...sandbox, egress: { allow: ['*.example.com'] } }, start: [] }),
		)

		// Act
		const loading = loadWorkflowConfig(directory)

		// Assert
		const error = await loading.catch((thrown: unknown) => String(thrown))
		expect(error).toContain('at sandbox.egress.allow[0]')
		expect(error).toContain('at start[0]')
	})

	test('says so when there is no config', async () => {
		// Arrange
		const directory = await temporaryDirectory()

		// Act
		const loading = loadWorkflowConfig(directory)

		// Assert
		await expect(loading).rejects.toThrow(`No ${workflowConfigFile}`)
	})
})

describe('entryFile', () => {
	test('is the configured file, with POSIX separators', () => {
		// Arrange
		const config = { sandbox, setup: [], start: ['node'] as [string], entry: 'flows\\team.mts' }

		// Act
		const file = entryFile(config)

		// Assert
		expect(file).toBe('flows/team.mts')
	})
})

describe('findEntry', () => {
	test('says so when the repository has no entry file', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(path.join(directory, workflowConfigFile), JSON.stringify({ sandbox, start: ['node'] }))

		// Act
		const finding = findEntry(directory)

		// Assert
		await expect(finding).rejects.toThrow('main.mts')
	})
})
