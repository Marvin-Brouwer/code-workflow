import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { keyFile, openCredentialStore, signInOf } from '@mesh-flow/gateway'
import { describe, expect, onTestFinished, test } from 'vitest'
import { loadConnectors } from '../src/connectors/load-connectors.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** A credential store of its own, in a fresh directory. */
async function credentialStore() {
	const home = await temporaryDirectory()
	return openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
}

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
		const loaded = await loadConnectors({
			connectors: [{ package: '@team/github' }, { package: 'tracker' }],
			from,
			directory,
			credentials: await credentialStore(),
		})

		// Assert
		expect(loaded.map((connector) => [connector.package, connector.name, connector.tools.map((tool) => tool.name)])).toEqual([
			['@team/github', 'github', ['githubComment']],
			['tracker', 'tracker', ['search']],
		])
		const context = { abortSignal: new AbortController().signal, credentials: { get: () => Promise.resolve(undefined) }, runId: 'run-1' }
		await expect(loaded[0]?.tools[0]?.run({}, context)).resolves.toBe(path.join(directory, 'github'))
	})

	test("carries a connector's sign-in, which only has the connector's own credentials", async () => {
		// Arrange
		const withLogin = `export const connector = {
	name: 'cloud',
	tools: () => [],
	login: async ({ credentials, abortSignal }) => {
		await credentials.set('cloud/session', 'token', abortSignal)
		await credentials.get('provider/work', abortSignal)
	},
}
`
		const from = await installed({ cloud: withLogin, tracker: hostModule('tracker', ['search']) })
		const directory = await temporaryDirectory()
		const credentials = await credentialStore()
		await credentials.set('provider/work', 'model key', abortSignal)

		// Act
		const loaded = await loadConnectors({ connectors: [{ package: 'cloud' }, { package: 'tracker' }], from, directory, credentials })
		const signingIn = loaded[0]?.login?.({ show: () => undefined, abortSignal })

		// Assert
		expect(loaded.map((connector) => [connector.name, typeof connector.login])).toEqual([
			['cloud', 'function'],
			['tracker', 'undefined'],
		])
		await expect(signingIn).rejects.toThrow('only has the credentials named cloud/')
		expect(await credentials.get('cloud/session', abortSignal)).toBe('token')
	})

	test("runs a tool once more when its connector's sign-in finished while it ran", async () => {
		// Arrange
		const signingIn = `let signedIn = false
let runs = 0
export const connector = {
	name: 'cloud',
	tools: () => [{
		name: 'cloudFetch',
		run: async () => {
			runs++
			if (runs === 1) {
				await globalThis.cloudLoginFinished
				throw Object.assign(new Error('Sign in to cloud.'), { signInTo: 'cloud' })
			}
			return signedIn ? runs : 'no session'
		},
	}],
	login: async () => {
		signedIn = true
	},
}
`
		const from = await installed({ cloud: signingIn })
		const { promise: loginFinished, resolve: finishLogin } = Promise.withResolvers<undefined>()
		Object.assign(globalThis, { cloudLoginFinished: loginFinished })
		onTestFinished(() => {
			Reflect.deleteProperty(globalThis, 'cloudLoginFinished')
		})
		const [cloud] = await loadConnectors({
			connectors: [{ package: 'cloud' }],
			from,
			directory: await temporaryDirectory(),
			credentials: await credentialStore(),
		})
		const context = { abortSignal, credentials: { get: () => Promise.resolve(undefined) }, runId: 'run-1' }

		// Act
		const fetching = cloud?.tools[0]?.run({}, context)
		await cloud?.login?.({ show: () => undefined, abortSignal })
		finishLogin(undefined)

		// Assert
		await expect(fetching).resolves.toBe(2)
	})

	test("turns a tool's ask for another connector's sign-in into a plain failure", async () => {
		// Arrange
		const foreign = `export const connector = {
	name: 'tracker',
	tools: () => [{ name: 'search', run: async () => { throw Object.assign(new Error('Sign in.'), { signInTo: 'aws' }) } }],
}
`
		const from = await installed({ tracker: foreign })
		const [tracker] = await loadConnectors({
			connectors: [{ package: 'tracker' }],
			from,
			directory: await temporaryDirectory(),
			credentials: await credentialStore(),
		})
		const context = { abortSignal, credentials: { get: () => Promise.resolve(undefined) }, runId: 'run-1' }

		// Act
		const searching = tracker?.tools[0]?.run({}, context)

		// Assert
		await expect(searching).rejects.toThrow('search asked for a sign-in to aws, not to its own connector tracker')
		expect(signInOf(await searching?.catch((rejected: unknown) => rejected))).toBeUndefined()
	})

	test('names the package that is not installed or has no host entry point', async () => {
		// Arrange
		const from = await installed({ 'no-host': undefined })
		const directory = await temporaryDirectory()
		const credentials = await credentialStore()

		// Act
		const missing = loadConnectors({ connectors: [{ package: '@team/missing' }], from, directory, credentials })
		const noHost = loadConnectors({ connectors: [{ package: 'no-host' }], from, directory, credentials })

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
		await expect(
			loadConnectors({ connectors: [{ package: 'plain' }], from, directory, credentials: await credentialStore() }),
		).rejects.toThrow("doesn't export a connector host")
		await expect(
			loadConnectors({ connectors: [{ package: 'one' }, { package: 'two' }], from, directory, credentials: await credentialStore() }),
		).rejects.toThrow('one and two both bring a host tool shared')
	})
})
