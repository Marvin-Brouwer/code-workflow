import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { appManifestFile, type WorkflowsDescription } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { buildApp } from '../src/build-app.mts'
import { appRepository, describingEntry } from './support/app-repository.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const signal = new AbortController().signal

const description: WorkflowsDescription = {
	sandbox: { image: 'node:22-slim', cpus: 2, memoryMb: 2048, egress: { allow: [] } },
	workflows: [{ name: 'greet', parameters: { type: 'object' } }],
	triggers: [{ kind: 'user', id: 'greet', workflow: 'greet' }],
}

const greetingPackage = { files: { 'index.js': `export const punctuation = '!'\n` } }

describe('buildApp', () => {
	test('bundles the entry file and what it imports into one file, and describes it', async () => {
		// Arrange
		const directory = await appRepository({
			files: { 'main.mts': describingEntry(description), 'greeting.mts': `export const greeting: string = 'Hello'\n` },
			packages: { greeting: greetingPackage },
		})
		const out = path.join(await temporaryDirectory(), 'app')

		// Act
		const manifest = await buildApp({ directory, out, abortSignal: signal })

		// Assert
		expect(manifest).toMatchObject({ entry: 'main.mjs', platform: { os: 'linux', cpu: 'x64' }, description })
		expect((await readdir(out)).toSorted()).toEqual(['main.mjs', appManifestFile, 'package.json'].toSorted())
		const bundled = await readFile(path.join(out, 'main.mjs'), 'utf8')
		expect(bundled).toContain('Hello')
		expect(bundled).not.toMatch(/from ['"]greeting['"]/)
		expect(JSON.parse(await readFile(path.join(out, appManifestFile), 'utf8'))).toEqual(manifest)
	})

	test('says where to point main when package.json has none', async () => {
		// Arrange
		const directory = await appRepository({ main: null })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal: signal })

		// Assert
		await expect(building).rejects.toThrow('has no "main"')
	})

	test("fails with the app's output when the entry file does not describe itself", async () => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': `console.error('no defineMeshFlow here')\n` } })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal: signal })

		// Assert
		await expect(building).rejects.toThrow(/exited without describing itself[\s\S]*no defineMeshFlow here/)
	})

	test('refuses an import it cannot find, rather than leaving it to the sandbox', async () => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': `import 'not-installed'\n` } })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal: signal })

		// Assert
		await expect(building).rejects.toThrow(/not-installed[\s\S]*Is it installed\?/)
	})

	test('refuses a dependency that compiles native code when the sandbox has another platform', async () => {
		// Arrange
		const directory = await appRepository({
			files: { 'main.mts': `import 'compiled'\n` },
			packages: { compiled: { json: { gypfile: true }, files: { 'binding.gyp': '{}', 'index.js': '' } } },
		})
		const other = process.arch === 'arm64' ? 'x64' : 'arm64'

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), platform: { os: 'linux', cpu: other }, abortSignal: signal })

		// Assert
		await expect(building).rejects.toThrow(`compiled compile native code when installed, so the app has to be built on linux-${other}`)
	})

	test('stops describing an app that never exits when aborted', async () => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': `setInterval(() => undefined, 60_000)\n` } })
		const controller = new AbortController()
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal: controller.signal })
		await expect.poll(() => existsSync(path.join(directory, 'out', 'main.mjs'))).toBe(true)

		// Act
		controller.abort(new Error('stop'))

		// Assert
		await expect(building).rejects.toThrow()
	})
})
