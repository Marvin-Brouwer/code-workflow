import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { uploadApp } from '../src/apps/upload-app.mts'
import { withPackedApp } from '../src/cli/with-packed-app.mts'
import { hostBackend } from './support/host-backend.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { builtApp, runtimeScript } from './support/test-app.mts'

const abortSignal = new AbortController().signal

describe.skipIf(process.platform !== 'linux')('uploadApp', () => {
	test('unpacks into a folder whose parent the image does not have, like /mesh-flow/app', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const sandbox = await hostBackend(root).create({ image: 'host', cpus: 1, memoryMb: 256, egress: { allow: [] } }, abortSignal)
		const folder = await builtApp({ ask: runtimeScript(`mailbox.send({ type: 'succeeded' })`) })

		// Act
		await withPackedApp(folder, (tarball) => uploadApp(sandbox, tarball, '/sandbox/mesh-flow/app', abortSignal), abortSignal)

		// Assert
		const files = path.join(root, sandbox.id, 'files', 'mesh-flow')
		expect(await readdir(files)).toEqual(['app'])
		const unpacked = await readdir(path.join(files, 'app'))
		expect(unpacked).toContain('mesh-flow.json')
		expect(unpacked).not.toContain('.app.tgz.b64')
	})
})
