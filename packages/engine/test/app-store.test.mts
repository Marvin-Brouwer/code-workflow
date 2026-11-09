import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppManifest } from '@mesh-flow/protocol'
import { describe, expect, test, vi } from 'vitest'
import { openAppStore } from '../src/apps/app-store.mts'
import { withPackedApp } from '../src/cli/with-packed-app.mts'
import { builtApp, runtimeScript, testAppName } from './support/test-app.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal
const hello = { hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) }

describe('openAppStore', () => {
	test('deploys the same tarball as the same version, and finds it again when opened anew', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = await openAppStore(root, abortSignal)
		const folder = await builtApp(hello)

		// Act
		const [first, again] = await withPackedApp(
			folder,
			async (tarball) => [await store.deploy(testAppName, tarball, abortSignal), await store.deploy(testAppName, tarball, abortSignal)],
			abortSignal,
		)
		const reopened = await openAppStore(root, abortSignal)

		// Assert
		expect(again.version).toBe(first.version)
		expect(first.version).toMatch(/^[0-9a-f]{12}$/)
		expect(reopened.current(testAppName)).toEqual(first)
		expect(reopened.list()).toEqual([first])
	})

	test('makes the last deploy the current version and keeps the earlier one for its runs', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const deploy = async (workflows: Record<string, string>) =>
			withPackedApp(await builtApp(workflows), (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)
		const first = await deploy(hello)

		// Act
		const second = await deploy({ ...hello, other: runtimeScript('') })

		// Assert
		expect(second.version).not.toBe(first.version)
		expect(store.current(testAppName)).toEqual(second)
		expect(store.list()).toHaveLength(1)
		expect(existsSync(first.tarball)).toBe(true)
	})

	test('refuses a tarball without a manifest', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const folder = await temporaryDirectory()
		await writeFile(path.join(folder, 'main.mjs'), '')

		// Act
		const deploying = withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
		await expect(deploying).rejects.toThrow('has no mesh-flow.json')
		expect(store.list()).toEqual([])
	})

	test('refuses a name that is not an app name', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const app = await builtApp(hello)

		// Act
		const deploying = withPackedApp(app, (tarball) => store.deploy('Not An App', tarball, abortSignal), abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
		expect(store.list()).toEqual([])
	})

	test('refuses a manifest with a sandbox the engine cannot make', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const folder = await builtApp(hello)
		const manifestFile = path.join(folder, 'mesh-flow.json')
		const manifest = AppManifest.parse(JSON.parse(await readFile(manifestFile, 'utf8')))
		const withZeroCpus = { ...manifest, description: { ...manifest.description, sandbox: { ...manifest.description.sandbox, cpus: 0 } } }
		await writeFile(manifestFile, JSON.stringify(withZeroCpus))

		// Act
		const deploying = withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
	})

	test('forgets a removed app, also when opened anew', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = await openAppStore(root, abortSignal)
		await withPackedApp(await builtApp(hello), (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)

		// Act
		const removed = await store.remove(testAppName, abortSignal)
		const again = await store.remove(testAppName, abortSignal)

		// Assert
		expect([removed, again]).toEqual([true, false])
		expect(store.current(testAppName)).toBeUndefined()
		expect((await openAppStore(root, abortSignal)).list()).toEqual([])
	})

	test('leaves a version be when the same build is deployed again, so a run copying it reads it whole', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const folder = await builtApp(hello)
		const first = await withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)
		const before = await stat(first.tarball)

		// Act
		await withPackedApp(folder, (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)

		// Assert
		const after = await stat(first.tarball)
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
	})

	test('keeps the current version and leaves nothing half written when a deploy is aborted', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const first = await withPackedApp(await builtApp(hello), (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)
		const aborted = AbortSignal.abort(new Error('Ctrl+C'))

		// Act
		const deploying = withPackedApp(
			await builtApp({ ...hello, other: runtimeScript('') }),
			(tarball) => store.deploy(testAppName, tarball, aborted),
			abortSignal,
		)

		// Assert
		await expect(deploying).rejects.toThrow('Ctrl+C')
		expect(store.current(testAppName)).toEqual(first)
		const appFolder = path.dirname(path.dirname(first.tarball))
		expect(new Set(await readdir(appFolder))).toEqual(new Set([path.basename(path.dirname(first.tarball)), 'current']))
	})

	test('refuses a file that is not a tarball', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const notATarball = path.join(await temporaryDirectory(), 'app.tgz')
		await writeFile(notATarball, 'not a tarball')

		// Act
		const deploying = store.deploy(testAppName, notATarball, abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
	})

	test('leaves out an app it cannot read, says so, and opens the others', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = await openAppStore(root, abortSignal)
		const good = await withPackedApp(await builtApp(hello), (tarball) => store.deploy(testAppName, tarball, abortSignal), abortSignal)
		const broken = await withPackedApp(await builtApp(hello), (tarball) => store.deploy('broken', tarball, abortSignal), abortSignal)
		await writeFile(path.join(path.dirname(broken.tarball), 'mesh-flow.json'), '{ "from": "an older engine" }')
		await mkdir(path.join(root, '.removed-gone-1'))
		const log = vi.fn<(message: string) => void>()

		// Act
		const reopened = await openAppStore(root, abortSignal, log)

		// Assert
		expect(reopened.list()).toEqual([good])
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Left out app broken'))
		expect(existsSync(path.join(root, '.removed-gone-1'))).toBe(false)
	})

	test('finishes a deploy under way when it closes, and refuses one after', async () => {
		// Arrange
		const store = await openAppStore(await temporaryDirectory(), abortSignal)
		const folder = await builtApp(hello)

		// Act
		const [deployed, afterClosing] = await withPackedApp(
			folder,
			async (tarball) => {
				const deploying = store.deploy(testAppName, tarball, abortSignal)
				await store.close()
				return Promise.allSettled([deploying, store.deploy(testAppName, tarball, abortSignal)])
			},
			abortSignal,
		)

		// Assert
		expect(deployed.status).toBe('fulfilled')
		expect(afterClosing).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
	})
})
