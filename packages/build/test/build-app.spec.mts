import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { appManifestFile, type WorkflowsDescription } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { buildApp } from '../src/build-app.mts'
import { describeBuiltApp } from '../src/describe-built-app.mts'
import { appRepository, describingEntry, protocolModule } from './support/app-repository.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

const run = promisify(execFile)

const description: WorkflowsDescription = {
	sandbox: { image: 'node:26-slim', cpus: 2, memoryMb: 2048, egress: { allow: [] } },
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

	test('keys a call site by its place in the source, the same across rebuilds, links and --enable-source-maps', async () => {
		// Arrange
		const files = { 'main.mts': printingKeyEntry, 'keyed.mts': keyedModule, 'greeting.mts': `export const greeting: string = 'Hello'\n` }
		const linesBeforeKeyed = 5
		const shiftingGreeting = {
			files: { 'index.js': `${'console.log("shifts the bundle")\n'.repeat(linesBeforeKeyed)}export const punctuation = '!'\n` },
		}
		const repository = await appRepository({ files, packages: { greeting: greetingPackage } })
		const shifted = await appRepository({ files, packages: { greeting: shiftingGreeting } })
		const linked = path.join(await temporaryDirectory(), 'linked')
		await symlink(repository, linked, 'junction')
		const [first, second, third] = [await outFolder(), await outFolder(), await outFolder()]

		// Act
		await buildApp({ directory: repository, out: first, abortSignal })
		await buildApp({ directory: shifted, out: second, abortSignal })
		await buildApp({ directory: linked, out: third, abortSignal })
		const keys = [
			await printedKey(first),
			await printedKey(second),
			await printedKey(third),
			await printedKey(first, ['--enable-source-maps']),
		]

		// Assert
		expect(await bundleLineOf(first, keyedCall)).not.toBe(await bundleLineOf(second, keyedCall))
		expect(keys).toEqual([keyedCallKey, keyedCallKey, keyedCallKey, keyedCallKey])
		expect(await mapSources(second)).toEqual(expect.arrayContaining(['keyed.mts', 'greeting/index.js']))
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

/**
 * Imports core's call sites from its sources, for the module the keying test writes. Deliberately
 * not through a public entry point: the test checks core's real keying in a built app without
 * making it part of core's API.
 */
const callSiteModule = pathToFileURL(path.join(import.meta.dirname, '../../core/src/run/call-site.mts')).href

/** The call whose site `keyed.mts` keys. */
const keyedCall = 'whereCalled()'

/** The key of `keyedCall`: its place in `keyed.mts`. */
const keyedCallKey = 'keyed.mts:6:20'

/** The environment variable that has the built entry print its key and exit. */
const printKeyVariable = 'MESH_FLOW_TEST_PRINT_KEY'

/** A module that keys its own call site the way a loop does, bundled after the `greeting` package. */
const keyedModule = `import 'greeting'
import { callSite, callSiteText } from '${callSiteModule}'
function whereCalled(): string {
	return callSiteText(callSite(1))
}
export const key = ${keyedCall}
`

/** An entry that prints the key when asked to, and describes itself otherwise. */
const printingKeyEntry = `import { key } from './keyed.mts'
if (process.env.${printKeyVariable} !== undefined) {
	console.log(key)
	process.exit(0)
}
${describingEntry(description)}`

/** A fresh folder for a built app. */
async function outFolder(): Promise<string> {
	return path.join(await temporaryDirectory(), 'app')
}

/** Runs the built app the way the sandbox does, from another working directory, and returns the key it printed last. */
async function printedKey(out: string, nodeOptions: readonly string[] = []): Promise<string> {
	const { stdout } = await run(process.execPath, [...nodeOptions, path.join(out, 'main.mjs')], {
		cwd: await temporaryDirectory(),
		env: { ...process.env, [printKeyVariable]: 'yes' },
	})
	return stdout.trim().split('\n').at(-1) ?? ''
}

/** The line of the built bundle that holds `text`, from 1. */
async function bundleLineOf(out: string, text: string): Promise<number> {
	const lines = (await readFile(path.join(out, 'main.mjs'), 'utf8')).split('\n')
	return lines.findIndex((line) => line.includes(text)) + 1
}

/** The files the built app's source map names. */
async function mapSources(out: string): Promise<readonly string[]> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the build writes the map
	return (JSON.parse(await readFile(path.join(out, 'main.mjs.map'), 'utf8')) as { sources: readonly string[] }).sources
}
