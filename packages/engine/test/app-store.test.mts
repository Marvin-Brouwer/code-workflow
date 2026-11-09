import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppManifest } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { openAppStore } from '../src/apps/app-store.mts'
import { withPackedApp } from '../src/cli/pack-app.mts'
import { builtApp, runtimeScript, testAppName } from './support/test-app.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const signal = new AbortController().signal
const hello = { hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) }

describe('openAppStore', () => {
	test('deploys the same tarball as the same version, and finds it again when opened anew', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = await openAppStore(root)
		const folder = await builtApp(hello)

		// Act
		const [first, again] = await withPackedApp(folder, async (tarball) => [
			await store.deploy(testAppName, tarball, signal),
			await store.deploy(testAppName, tarball, signal),
		])
		const reopened = await openAppStore(root)

		// Assert
		expect(again.version).toBe(first.version)
		expect(first.version).toMatch(/^[0-9a-f]{12}$/)
		expect(reopened.current(testAppName)).toEqual(first)
		expect(reopened.list()).toEqual([first])
	})

	test('makes the last deploy the current version and keeps the earlier one for its runs', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory())
		const deploy = async (workflows: Record<string, string>) =>
			withPackedApp(await builtApp(workflows), (tarball) => store.deploy(testAppName, tarball, signal))
		const first = await deploy(hello)

		// Act
		const second = await deploy({ ...hello, other: runtimeScript('') })

		// Assert
		expect(second.version).not.toBe(first.version)
		expect(store.current(testAppName)).toEqual(second)
		expect(store.list()).toHaveLength(1)
		expect(existsSync(first.tarball)).toBe(true)
	})

	test('refuses a tarball without a manifest, and a name that is not one', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory())
		const folder = await temporaryDirectory()
		await writeFile(path.join(folder, 'main.mjs'), '')
		const app = await builtApp(hello)

		// Act
		const withoutManifest = withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, signal))
		const badName = withPackedApp(app, (tarball) => store.deploy('Not An App', tarball, signal))

		// Assert
		await expect(withoutManifest).rejects.toMatchObject({ code: 'invalid' })
		await expect(withoutManifest).rejects.toThrow('has no mesh-flow.json')
		await expect(badName).rejects.toMatchObject({ code: 'invalid' })
		expect(store.list()).toEqual([])
	})

	test('refuses a manifest with a sandbox the engine cannot make', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory())
		const folder = await builtApp(hello)
		const manifestFile = path.join(folder, 'mesh-flow.json')
		const manifest = AppManifest.parse(JSON.parse(await readFile(manifestFile, 'utf8')))
		const withoutCpus = { ...manifest, description: { ...manifest.description, sandbox: { ...manifest.description.sandbox, cpus: 0 } } }
		await writeFile(manifestFile, JSON.stringify(withoutCpus))

		// Act
		const deploying = withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, signal))

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
	})

	test('forgets a removed app, also when opened anew', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = await openAppStore(root)
		await withPackedApp(await builtApp(hello), (tarball) => store.deploy(testAppName, tarball, signal))

		// Act
		const removed = await store.remove(testAppName)
		const again = await store.remove(testAppName)

		// Assert
		expect([removed, again]).toEqual([true, false])
		expect(store.current(testAppName)).toBeUndefined()
		expect((await openAppStore(root)).list()).toEqual([])
	})
})
