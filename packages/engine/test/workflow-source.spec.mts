import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { list } from 'tar'
import { describe, expect, test } from 'vitest'
import { packWorkflowSource } from '../src/workflow/workflow-source.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { workflowRepository } from './support/workflow-repository.mts'

const signal = new AbortController().signal

async function entriesOf(tarball: string): Promise<Set<string>> {
	const entries = new Set<string>()
	await list({ file: tarball, onReadEntry: (entry) => entries.add(entry.path) })
	return entries
}

describe('packWorkflowSource', () => {
	test('packs the committed files and pins the commit', async () => {
		// Arrange
		const directory = await workflowRepository({ develop: '' })
		const tarball = path.join(await temporaryDirectory(), 'source.tgz')

		// Act
		const source = await packWorkflowSource(directory, tarball, signal)

		// Assert
		expect(source.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim())
		expect(source.dirty).toBe(false)
		expect(await entriesOf(tarball)).toEqual(new Set(['mesh-flow.config.json', 'workflows/develop.mts']))
	})

	test('packs uncommitted and untracked files too, but not ignored ones, and says it is dirty', async () => {
		// Arrange
		const directory = await workflowRepository({ develop: '' })
		await writeFile(path.join(directory, '.gitignore'), 'node_modules/\n')
		await mkdir(path.join(directory, 'node_modules'))
		await writeFile(path.join(directory, 'node_modules', 'big.js'), '')
		await writeFile(path.join(directory, 'workflows', 'new.mts'), '')
		const tarball = path.join(await temporaryDirectory(), 'source.tgz')

		// Act
		const source = await packWorkflowSource(directory, tarball, signal)

		// Assert
		expect(source.dirty).toBe(true)
		expect(await entriesOf(tarball)).toEqual(new Set(['.gitignore', 'mesh-flow.config.json', 'workflows/develop.mts', 'workflows/new.mts']))
	})
})
