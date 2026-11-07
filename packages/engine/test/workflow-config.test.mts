import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { findWorkflow, loadWorkflowConfig, workflowFile } from '../src/workflow/workflow-config.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const sandbox = { image: 'node:22-slim', cpus: 2, memoryMb: 2048, egress: { allow: ['registry.npmjs.org'] } }

describe('loadWorkflowConfig', () => {
	test('fills in the defaults', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(path.join(directory, 'mesh-flow.config.json'), JSON.stringify({ sandbox, start: ['node'] }))

		// Act
		const config = await loadWorkflowConfig(directory)

		// Assert
		expect(config).toEqual({ sandbox, setup: [], start: ['node'], workflows: 'workflows' })
	})

	test('says what is wrong with a bad config', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(
			path.join(directory, 'mesh-flow.config.json'),
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
		await expect(loading).rejects.toThrow('No mesh-flow.config.json')
	})
})

describe('workflowFile', () => {
	const config = { sandbox, setup: [], start: ['node'] as [string], workflows: 'workflows' }

	test('finds a workflow in the workflows folder, also in a subfolder', () => {
		// Act
		const files = [workflowFile(config, 'develop'), workflowFile(config, 'review/handle-comments')]

		// Assert
		expect(files).toEqual(['workflows/develop.mts', 'workflows/review/handle-comments.mts'])
	})

	test.each(['../secrets', '/etc/passwd', 'develop.mts', ''])('refuses %j as a workflow name', (name) => {
		// Act
		const find = () => workflowFile(config, name)

		// Assert
		expect(find).toThrow("isn't a workflow name")
	})

	test('refuses a workflow whose file is missing', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		await writeFile(path.join(directory, 'mesh-flow.config.json'), JSON.stringify({ sandbox, start: ['node'] }))

		// Act
		const finding = findWorkflow(directory, 'develop')

		// Assert
		await expect(finding).rejects.toThrow("There is no workflow 'develop'")
	})
})
