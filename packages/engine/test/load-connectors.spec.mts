import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadConnectors } from '../src/connectors/load-connectors.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** A host entry point that brings host tools named `tools`, under the connector name `name`. */
function hostModule(name: string, tools: readonly string[]): string {
	return `export const connector = {
	name: ${JSON.stringify(name)},
	tools: ({ directory }) => ${JSON.stringify(tools)}.map((name) => ({ name, run: () => Promise.resolve(directory) })),
}
`
}

/**
 * A directory with `node_modules` holding one package per entry: its `host` export points at a
 * module with `source`, or is left out when `source` is undefined.
 */
async function installed(packages: Record<string, string | undefined>): Promise<string> {
	const root = await temporaryDirectory()
	for (const [name, source] of Object.entries(packages)) {
		// The package lives outside node_modules, where vitest still transforms TypeScript; node_modules holds a link to it under its name.
		const target = path.join(root, 'packages', name.replaceAll('/', '__'))
		await mkdir(target, { recursive: true })
		const exports = source === undefined ? {} : { './host': './host.mts' }
		await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, type: 'module', exports }))
		if (source !== undefined) await writeFile(path.join(target, 'host.mts'), source)
		await mkdir(path.dirname(path.join(root, 'node_modules', name)), { recursive: true })
		await symlink(target, path.join(root, 'node_modules', name), 'junction')
	}
	return root
}

describe('loadConnectors', () => {
	test('loads the host tools of each package from its host entry point, with a directory of its own', async () => {
		// Arrange
		const from = await installed({ '@team/github': hostModule('github', ['githubComment']), tracker: hostModule('tracker', ['search']) })
		const directory = path.join(await temporaryDirectory(), 'connectors')

		// Act
		const loaded = await loadConnectors({ connectors: [{ package: '@team/github' }, { package: 'tracker' }], from, directory })

		// Assert
		expect(loaded.map((connector) => [connector.package, connector.name, connector.tools.map((tool) => tool.name)])).toEqual([
			['@team/github', 'github', ['githubComment']],
			['tracker', 'tracker', ['search']],
		])
		const context = { abortSignal: new AbortController().signal, credentials: { get: () => Promise.resolve(undefined) }, runId: 'run-1' }
		await expect(loaded[0]?.tools[0]?.run({}, context)).resolves.toBe(path.join(directory, 'github'))
	})

	test('names the package that is not installed or has no host entry point', async () => {
		// Arrange
		const from = await installed({ 'no-host': undefined })
		const directory = await temporaryDirectory()

		// Act
		const missing = loadConnectors({ connectors: [{ package: '@team/missing' }], from, directory })
		const noHost = loadConnectors({ connectors: [{ package: 'no-host' }], from, directory })

		// Assert
		await expect(missing).rejects.toThrow("@team/missing isn't installed")
		await expect(noHost).rejects.toThrow("no-host isn't installed")
	})

	test('refuses a host entry point without a connector, and two connectors with one tool name', async () => {
		// Arrange
		const from = await installed({
			plain: 'export const tools = []\n',
			one: hostModule('one', ['shared']),
			two: hostModule('two', ['shared']),
		})
		const directory = await temporaryDirectory()

		// Act, Assert: one at a time, or the second rejects unhandled while the first is awaited
		await expect(loadConnectors({ connectors: [{ package: 'plain' }], from, directory })).rejects.toThrow("doesn't export a connector host")
		await expect(loadConnectors({ connectors: [{ package: 'one' }, { package: 'two' }], from, directory })).rejects.toThrow(
			'one and two both bring a host tool shared',
		)
	})
})
