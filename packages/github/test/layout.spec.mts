import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { filesAt, lintSettingsAt, localGit, templatesAt } from '@mesh-flow/code-repository'
import { describe, expect, onTestFinished, test } from 'vitest'
import { githubLayout } from '../src/pull-request/layout.mts'
import { git } from './support/local-remote.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** The byte order mark an editor may start a file with. */
const byteOrderMark = String.fromCodePoint(0xfe_ff)

/** A repository with one commit holding `files`, and git on it. */
async function committed(files: Readonly<Record<string, string>>) {
	const directory = await temporaryDirectory()
	await git(directory, 'init', '--quiet', '--initial-branch=main')
	for (const [file, text] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
		await writeFile(path.join(directory, file), text)
	}
	await git(directory, 'add', '--all')
	await git(directory, 'commit', '--quiet', '--message', 'Start')
	const abortController = new AbortController()
	onTestFinished(() => {
		abortController.abort()
	})
	return localGit(directory, abortController.signal)
}

/** The paths of the templates at `HEAD`. */
async function templatePaths(files: Readonly<Record<string, string>>): Promise<string[]> {
	const repositoryGit = await committed(files)
	const templates = await templatesAt(repositoryGit, 'HEAD', await filesAt(repositoryGit, 'HEAD', githubLayout), githubLayout)
	return templates.map((template) => template.path)
}

/** The lint settings at `HEAD`. */
async function lintSettings(files: Readonly<Record<string, string>>) {
	const repositoryGit = await committed(files)
	return lintSettingsAt(repositoryGit, 'HEAD', await filesAt(repositoryGit, 'HEAD', githubLayout), githubLayout)
}

describe('templatesAt', () => {
	test('finds the template in the root and in docs', async () => {
		// Act
		const found = await templatePaths({ 'pull_request_template.md': '## Root\n', 'docs/pull_request_template.md': '## Docs\n' })

		// Assert
		expect(found.toSorted()).toEqual(['docs/pull_request_template.md', 'pull_request_template.md'])
	})

	test('finds the template whatever the case of its folder and name', async () => {
		// Act
		const found = await templatePaths({ '.GitHub/Pull_Request_Template.md': '## Summary\n' })

		// Assert
		expect(found).toEqual(['.GitHub/Pull_Request_Template.md'])
	})

	test('finds every Markdown template in a folder of templates, without its subfolders', async () => {
		// Act
		const found = await templatePaths({
			'.github/PULL_REQUEST_TEMPLATE/bug.md': '## Bug\n',
			'.github/PULL_REQUEST_TEMPLATE/feature.md': '## Feature\n',
			'.github/PULL_REQUEST_TEMPLATE/notes.txt': 'Not a template.\n',
			'.github/PULL_REQUEST_TEMPLATE/old/bug.md': '## Old bug\n',
		})

		// Assert
		expect(found.toSorted()).toEqual(['.github/PULL_REQUEST_TEMPLATE/bug.md', '.github/PULL_REQUEST_TEMPLATE/feature.md'])
	})

	test('leaves out a template deeper in docs', async () => {
		// Act
		const found = await templatePaths({ 'docs/guides/pull_request_template.md': '## Guide\n' })

		// Assert
		expect(found).toEqual([])
	})
})

describe('lintSettingsAt', () => {
	test('takes a commitlint settings file and a workflow that checks the title, whatever their case', async () => {
		// Act
		const settings = await lintSettings({
			'.CommitLintRC.json': '{ "extends": ["@commitlint/config-conventional"] }\n',
			'.github/workflows/title.yml': 'uses: amannn/action-semantic-pull-request@v5\n',
			'.github/workflows/build.yml': 'run: pnpm build\n',
			'docs/commitlint.config.ts': 'export default {}\n',
		})

		// Assert
		expect(settings.map((setting) => setting.path).toSorted()).toEqual(['.CommitLintRC.json', '.github/workflows/title.yml'])
	})

	test('takes commitlint from package.json, without the rest of the file', async () => {
		// Act
		const settings = await lintSettings({
			'package.json': JSON.stringify({ name: 'app', commitlint: { extends: ['@commitlint/config-conventional'] } }),
		})

		// Assert
		expect(settings).toEqual([
			{ path: 'package.json', text: '{\n\t"commitlint": {\n\t\t"extends": [\n\t\t\t"@commitlint/config-conventional"\n\t\t]\n\t}\n}' },
		])
	})

	test('takes commitlint from a package.json that starts with a byte order mark', async () => {
		// Act
		const settings = await lintSettings({ 'package.json': `${byteOrderMark}${JSON.stringify({ commitlint: { extends: ['x'] } })}` })

		// Assert
		expect(settings.map((setting) => setting.path)).toEqual(['package.json'])
	})

	test('takes nothing from a package.json that is not JSON', async () => {
		// Act
		const settings = await lintSettings({ 'package.json': '{ "commitlint": ' })

		// Assert
		expect(settings).toEqual([])
	})
})
