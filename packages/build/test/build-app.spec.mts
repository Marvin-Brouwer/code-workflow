import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { SourceMap, type SourceMapPayload } from 'node:module'
import path from 'node:path'
import { appManifestFile, type WorkflowsDescription } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { buildApp } from '../src/build-app.mts'
import { describeBuiltApp } from '../src/describe-built-app.mts'
import { appRepository, describingEntry, protocolModule } from './support/app-repository.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

const description: WorkflowsDescription = {
	sandbox: { image: 'node:22-slim', cpus: 2, memoryMb: 2048, egress: { allow: [] } },
	workflows: [{ name: 'greet', parameters: { type: 'object' } }],
	triggers: [{ kind: 'user', id: 'greet', workflow: 'greet' }],
	tools: [],
	models: [],
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
		const manifest = await buildApp({ directory, out, abortSignal })

		// Assert
		expect(manifest).toMatchObject({ entry: 'main.mjs', platform: { os: 'linux', cpu: 'x64' }, description })
		expect((await readdir(out)).toSorted()).toEqual(['main.mjs', 'main.mjs.map', appManifestFile, 'package.json'].toSorted())
		const bundled = await readFile(path.join(out, 'main.mjs'), 'utf8')
		expect(bundled).toContain('Hello')
		expect(bundled).not.toMatch(/from ['"]greeting['"]/)
		expect(JSON.parse(await readFile(path.join(out, appManifestFile), 'utf8'))).toEqual(manifest)
	})

	test("maps the bundle back to the app's files, so a place in the source stays put across rebuilds", async () => {
		// Arrange
		const files = {
			'main.mts': `${describingEntry(description)}import { marked } from './marked.mts'\nconsole.log(marked())\n`,
			'marked.mts': `export function marked(): string {\n\treturn new Error('marker').message\n}\n`,
			'greeting.mts': `export const greeting: string = 'Hello'\n`,
		}
		const padded = { files: { 'index.js': `${'console.log("padding")\n'.repeat(5)}export const punctuation = '!'\n` } }
		const first = path.join(await temporaryDirectory(), 'app')
		const second = path.join(await temporaryDirectory(), 'app')

		// Act
		await buildApp({ directory: await appRepository({ files, packages: { greeting: greetingPackage } }), out: first, abortSignal })
		await buildApp({ directory: await appRepository({ files, packages: { greeting: padded } }), out: second, abortSignal })

		// Assert
		const [before, after] = await Promise.all([sourceOf(first, '"marker"'), sourceOf(second, '"marker"')])
		expect(before.lineNumber).not.toBe(after.lineNumber)
		expect(before.origin).toEqual({ fileName: 'marked.mts', lineNumber: 2, columnNumber: 19 })
		expect(after.origin).toEqual(before.origin)
		expect(after.sources).toEqual(expect.arrayContaining(['marked.mts', 'greeting/index.js']))
	})

	test('says where to point main when package.json has none', async () => {
		// Arrange
		const directory = await appRepository({ main: null })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal })

		// Assert
		await expect(building).rejects.toThrow('has no "main"')
	})

	test("fails with the app's output when the entry file does not describe itself", async () => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': `console.error('no defineMeshFlow here')\n` } })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal })

		// Assert
		await expect(building).rejects.toThrow(/exited without describing itself[\s\S]*no defineMeshFlow here/)
	})

	test('refuses an import it cannot find, rather than leaving it to the sandbox', async () => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': `import 'not-installed'\n` } })

		// Act
		const building = buildApp({ directory, out: path.join(directory, 'out'), abortSignal })

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
		const building = buildApp({ directory, out: path.join(directory, 'out'), platform: { os: 'linux', cpu: other }, abortSignal })

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

	test.each([
		['the repository', '.'],
		['a folder that holds it', '..'],
	])('refuses to empty %s as the output', async (_name, relative) => {
		// Arrange
		const directory = await appRepository({ files: { 'main.mts': describingEntry(description) } })

		// Act
		const building = buildApp({ directory, out: path.join(directory, relative), abortSignal })

		// Assert
		await expect(building).rejects.toThrow('holds the app')
		expect(existsSync(path.join(directory, 'package.json'))).toBe(true)
	})
})

describe('describeBuiltApp', () => {
	test("loads native dependencies from the repository, not the sandbox's next to the bundle", async () => {
		// Arrange
		const entry = `import { RuntimeMailbox } from '${protocolModule}'
import { native } from 'native'

const mailbox = RuntimeMailbox.fromEnvironment()
await mailbox.readStart(new AbortController().signal)
if (native === 'host') mailbox.send({ type: 'described', description: ${JSON.stringify(description)} })
`
		const directory = await appRepository({
			files: { 'main.mjs': entry },
			packages: { native: { files: { 'index.js': `export const native = 'host'\n` } } },
		})
		const out = await temporaryDirectory()
		await copyFile(path.join(directory, 'main.mjs'), path.join(out, 'main.mjs'))
		// Built for the sandbox: it can't load here.
		await mkdir(path.join(out, 'node_modules', 'native'), { recursive: true })
		await writeFile(
			path.join(out, 'node_modules', 'native', 'package.json'),
			JSON.stringify({ name: 'native', type: 'module', main: 'index.js' }),
		)
		await writeFile(path.join(out, 'node_modules', 'native', 'index.js'), `throw new Error('wrong platform')\n`)

		// Act
		const described = await describeBuiltApp({ bundle: path.join(out, 'main.mjs'), directory, abortSignal })

		// Assert
		expect(described).toEqual(description)
		expect(await readdir(path.join(directory, '.mesh-flow'))).toEqual([])
	})
})

/** Where `text` is in the built bundle, and where the source map says it came from. */
async function sourceOf(out: string, text: string): Promise<{ lineNumber: number; origin: unknown; sources: readonly string[] }> {
	const lines = (await readFile(path.join(out, 'main.mjs'), 'utf8')).split('\n')
	const index = lines.findIndex((line) => line.includes(text))
	const lineNumber = index + 1
	const column = (lines[index] ?? '').indexOf(text) + 1
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the build writes the map
	const payload = JSON.parse(await readFile(path.join(out, 'main.mjs.map'), 'utf8')) as SourceMapPayload
	return { lineNumber, origin: new SourceMap(payload).findOrigin(lineNumber, column), sources: payload.sources }
}
