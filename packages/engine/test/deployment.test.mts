import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type * as FileSystem from 'node:fs/promises'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppManifest } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { currentFile, openDeployment, type Deployment, type DeploymentVersion } from '../src/app/deployment.mts'
import { withPackedApp } from '../src/cli/with-packed-app.mts'
import { deferred } from './support/deferred.mts'
import { builtApp, runtimeScript } from './support/test-app.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** The folders `rm` refuses to remove, as one in use does on Windows. */
const removal = vi.hoisted(() => ({ refused: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof FileSystem>()
	return {
		...actual,
		rm: async (target: string, options?: Parameters<typeof actual.rm>[1]) => {
			if (removal.refused.has(target)) throw Object.assign(new Error(`EBUSY: resource busy, rm '${target}'`), { code: 'EBUSY' })
			return actual.rm(target, options)
		},
	}
})

const abortSignal = new AbortController().signal
const hello = { hello: runtimeScript(`mailbox.send({ type: 'succeeded' })`) }
const other = { ...hello, other: runtimeScript('') }

/** Named like a version, 12 hex characters, as one an earlier deploy left. */
const leftoverVersion = '0123456789ab'
const otherLeftoverVersion = 'ba9876543210'

/** The deployment in `root`, closed when the test ends. */
async function openedDeployment(root: string, log?: (message: string) => void): Promise<Deployment> {
	const deployment = await openDeployment(root, abortSignal, log)
	onTestFinished(() => deployment.close())
	return deployment
}

/** Builds a test app with `workflows` and deploys it. */
async function deployBuilt(deployment: Deployment, workflows: Record<string, string>): Promise<DeploymentVersion> {
	return withPackedApp(await builtApp(workflows), (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)
}

describe('openDeployment', () => {
	test('deploys the same tarball as the same version, and finds it again when opened anew', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const folder = await builtApp(hello)

		// Act
		const [first, again] = await withPackedApp(
			folder,
			async (tarball) => [await deployment.deploy(tarball, abortSignal), await deployment.deploy(tarball, abortSignal)],
			abortSignal,
		)
		const reopened = await openedDeployment(root)

		// Assert
		expect(again.version).toBe(first.version)
		expect(first.version).toMatch(/^[0-9a-f]{12}$/)
		expect(reopened.current()).toEqual(first)
	})

	test('makes the last deploy the current version and removes the earlier one', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const first = await deployBuilt(deployment, hello)

		// Act
		const second = await deployBuilt(deployment, other)

		// Assert
		expect(second.version).not.toBe(first.version)
		expect(deployment.current()).toEqual(second)
		expect(new Set(await readdir(root))).toEqual(new Set([second.version, currentFile]))
	})

	test('keeps a version a copy holds until the copy is done, also when another is deployed meanwhile', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const first = await deployBuilt(deployment, hello)
		const copying = deferred<undefined>()
		const holding = deployment.withCurrent(async (held) => {
			await copying.promise
			return held
		})

		// Act
		await deployBuilt(deployment, other)
		const keptWhileHeld = existsSync(first.tarball)
		copying.resolve(undefined)
		const held = await holding

		// Assert
		expect(held).toEqual(first)
		expect(keptWhileHeld).toBe(true)
		await vi.waitFor(() => {
			expect(existsSync(path.dirname(first.tarball))).toBe(false)
		})
	})

	test('keeps a version let go after it closed, without failing the copy, and removes it at the next open', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const first = await deployBuilt(deployment, hello)
		const copying = deferred<undefined>()
		const holding = deployment.withCurrent(async (held) => {
			await copying.promise
			return held
		})
		await deployBuilt(deployment, other)

		// Act
		await deployment.close()
		copying.resolve(undefined)
		const held = await holding
		const keptAfterClosing = existsSync(first.tarball)
		await openedDeployment(root)

		// Assert
		expect(held).toEqual(first)
		expect(keptAfterClosing).toBe(true)
		expect(existsSync(path.dirname(first.tarball))).toBe(false)
	})

	test('closes while a copy never settles', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		await deployBuilt(deployment, hello)
		void deployment.withCurrent(() => new Promise<never>(() => undefined))

		// Act
		const closing = deployment.close()

		// Assert
		await expect(closing).resolves.toBeUndefined()
	})

	test('removes the other older versions when one is in use, and that one at the next deploy', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		await deployBuilt(deployment, hello)
		const inUse = path.join(root, leftoverVersion)
		const removable = path.join(root, otherLeftoverVersion)
		await Promise.all([mkdir(inUse), mkdir(removable)])
		removal.refused.add(inUse)
		onTestFinished(() => {
			removal.refused.clear()
		})
		const log = vi.fn<(message: string) => void>()

		// Act
		const reopened = await openedDeployment(root, log)
		const keptWhileInUse = existsSync(inUse)
		removal.refused.clear()
		await deployBuilt(reopened, other)

		// Assert
		expect(log).toHaveBeenCalledWith(expect.stringContaining(`Removing version ${leftoverVersion}`))
		expect(keptWhileInUse).toBe(true)
		expect(existsSync(removable)).toBe(false)
		expect(existsSync(inUse)).toBe(false)
	})

	test('removes what it wrote of a version whose deploy failed', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const folder = await builtApp(hello)

		// Act
		const deploying = withPackedApp(
			folder,
			async (tarball) => {
				const version = createHash('sha256')
					.update(await readFile(tarball))
					.digest('hex')
					.slice(0, leftoverVersion.length)
				// A folder where the tarball goes, so copying it there fails.
				await mkdir(path.join(root, version, 'app.tgz'), { recursive: true })
				return deployment.deploy(tarball, abortSignal)
			},
			abortSignal,
		)

		// Assert
		await expect(deploying).rejects.toThrow()
		expect(await readdir(root)).toEqual([])
		expect(deployment.current()).toBeUndefined()
	})

	test('removes older versions a crash left behind when it opens', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const current = await deployBuilt(deployment, hello)
		const leftover = path.join(root, leftoverVersion)
		await mkdir(leftover)

		// Act
		await openedDeployment(root)

		// Assert
		expect(existsSync(leftover)).toBe(false)
		expect(existsSync(current.tarball)).toBe(true)
	})

	test('refuses a tarball without a manifest', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const folder = await temporaryDirectory()
		await writeFile(path.join(folder, 'main.mjs'), '')

		// Act
		const deploying = withPackedApp(folder, (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
		await expect(deploying).rejects.toThrow('has no mesh-flow.json')
		expect(deployment.current()).toBeUndefined()
	})

	test('refuses a manifest with a sandbox the engine cannot make', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const folder = await builtApp(hello)
		const manifestFile = path.join(folder, 'mesh-flow.json')
		const manifest = AppManifest.parse(JSON.parse(await readFile(manifestFile, 'utf8')))
		const withZeroCpus = { ...manifest, description: { ...manifest.description, sandbox: { ...manifest.description.sandbox, cpus: 0 } } }
		await writeFile(manifestFile, JSON.stringify(withZeroCpus))

		// Act
		const deploying = withPackedApp(folder, (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
	})

	test('leaves a version be when the same build is deployed again, so a run copying it reads it whole', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const folder = await builtApp(hello)
		const first = await withPackedApp(folder, (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)
		const before = await stat(first.tarball)

		// Act
		await withPackedApp(folder, (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)

		// Assert
		const after = await stat(first.tarball)
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
	})

	test('keeps the current version and leaves nothing half written when a deploy is aborted', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const first = await withPackedApp(await builtApp(hello), (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)
		const aborted = AbortSignal.abort(new Error('Ctrl+C'))

		// Act
		const deploying = withPackedApp(await builtApp(other), (tarball) => deployment.deploy(tarball, aborted), abortSignal)

		// Assert
		await expect(deploying).rejects.toThrow('Ctrl+C')
		expect(deployment.current()).toEqual(first)
		const root = path.dirname(path.dirname(first.tarball))
		expect(new Set(await readdir(root))).toEqual(new Set([path.basename(path.dirname(first.tarball)), currentFile]))
	})

	test('refuses a file that is not a tarball', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const notATarball = path.join(await temporaryDirectory(), 'app.tgz')
		await writeFile(notATarball, 'not a tarball')

		// Act
		const deploying = deployment.deploy(notATarball, abortSignal)

		// Assert
		await expect(deploying).rejects.toMatchObject({ code: 'invalid' })
	})

	test('leaves out a current version it cannot read, says so, and takes a new deploy', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const broken = await withPackedApp(await builtApp(hello), (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)
		await writeFile(path.join(path.dirname(broken.tarball), 'mesh-flow.json'), '{ "from": "an older engine" }')
		const log = vi.fn<(message: string) => void>()

		// Act
		const reopened = await openedDeployment(root, log)
		const fixed = await withPackedApp(await builtApp(other), (tarball) => reopened.deploy(tarball, abortSignal), abortSignal)

		// Assert
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Left out the app'))
		expect(reopened.current()).toEqual(fixed)
	})

	test.each([
		['names a version whose folder is gone', (_: string, folder: string) => rm(folder, { recursive: true })],
		['names no version at all', (root: string) => writeFile(path.join(root, currentFile), '')],
	])('says so when its current file %s, instead of starting as if nothing was deployed', async (_name, breakIt) => {
		// Arrange
		const root = await temporaryDirectory()
		const deployment = await openedDeployment(root)
		const deployed = await withPackedApp(await builtApp(hello), (tarball) => deployment.deploy(tarball, abortSignal), abortSignal)
		await breakIt(root, path.dirname(deployed.tarball))
		const log = vi.fn<(message: string) => void>()

		// Act
		const reopened = await openedDeployment(root, log)

		// Assert
		expect(reopened.current()).toBeUndefined()
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Left out the app'))
	})

	test('finishes a deploy under way when it closes, and refuses one after', async () => {
		// Arrange
		const deployment = await openedDeployment(await temporaryDirectory())
		const folder = await builtApp(hello)

		// Act
		const [deployed, afterClosing] = await withPackedApp(
			folder,
			async (tarball) => {
				const deploying = deployment.deploy(tarball, abortSignal)
				await deployment.close()
				return Promise.allSettled([deploying, deployment.deploy(tarball, abortSignal)])
			},
			abortSignal,
		)

		// Assert
		expect(deployed.status).toBe('fulfilled')
		expect(afterClosing).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
	})
})
