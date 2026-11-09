import { execFileSync } from 'node:child_process'
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { list } from 'tar'
import { describe, expect, test } from 'vitest'
import { packWorkflowSource, sourceKey } from '../src/workflow/workflow-source.mts'
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
		expect(await entriesOf(tarball)).toEqual(new Set(['main.mts', 'mesh-flow.config.json', 'workflows/develop.mts']))
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
		expect(await entriesOf(tarball)).toEqual(
			new Set(['.gitignore', 'main.mts', 'mesh-flow.config.json', 'workflows/develop.mts', 'workflows/new.mts']),
		)
	})
})

describe.skipIf(process.platform === 'win32')('sourceKey', () => {
	test('counts a symbolic link by its target, not by what it points at', async () => {
		// Arrange
		const directory = await workflowRepository({ develop: '' })
		const outside = path.join(await temporaryDirectory(), 'outside.txt')
		await writeFile(outside, 'one')
		const link = path.join(directory, 'workflows', 'link.mts')
		await symlink(outside, link)
		const before = await sourceKey(directory, signal)

		// Act
		await writeFile(outside, 'two')
		const contentChanged = await sourceKey(directory, signal)
		await unlink(link)
		await symlink(`${outside}.other`, link)
		const targetChanged = await sourceKey(directory, signal)

		// Assert
		expect(contentChanged).toBe(before)
		expect(targetChanged).not.toBe(before)
	})

	test('takes a symbolic link to a directory', async () => {
		// Arrange
		const directory = await workflowRepository({ develop: '' })
		await symlink(await temporaryDirectory(), path.join(directory, 'workflows', 'shared'))

		// Act
		const key = sourceKey(directory, signal)

		// Assert
		await expect(key).resolves.toMatch(/^[0-9a-f]{64}$/)
	})
})
