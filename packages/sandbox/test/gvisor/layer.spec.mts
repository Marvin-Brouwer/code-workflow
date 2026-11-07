import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { applyLayer } from '../../src/gvisor/layer.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

const execFileAsync = promisify(execFile)

function timeout(): AbortSignal {
	return AbortSignal.timeout(5000)
}

/** A layer archive with these files, by path inside the layer. */
async function layerArchive(directory: string, files: Readonly<Record<string, string>>): Promise<string> {
	const content = path.join(directory, 'layer-content')
	for (const [file, text] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(content, file)), { recursive: true })
		await writeFile(path.join(content, file), text)
	}
	const archive = path.join(directory, 'layer.tar')
	await execFileAsync('tar', ['-cf', archive, '-C', content, '.'])
	return archive
}

describe('applyLayer', () => {
	test('deletes a whited-out file and adds the new ones', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const rootfs = path.join(directory, 'rootfs')
		await mkdir(path.join(rootfs, 'etc'), { recursive: true })
		await writeFile(path.join(rootfs, 'etc', 'old'), 'old')
		const archive = await layerArchive(directory, { 'etc/.wh.old': '', 'etc/new': 'new' })

		// Act
		await applyLayer(archive, rootfs, timeout())

		// Assert
		expect(await readdir(path.join(rootfs, 'etc'))).toEqual(['new'])
	})

	test('empties an opaque directory before the layer fills it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const rootfs = path.join(directory, 'rootfs')
		await mkdir(path.join(rootfs, 'app'), { recursive: true })
		await writeFile(path.join(rootfs, 'app', 'lower'), 'lower')
		const archive = await layerArchive(directory, { 'app/.wh..wh..opq': '', 'app/upper': 'upper' })

		// Act
		await applyLayer(archive, rootfs, timeout())

		// Assert
		expect(await readdir(path.join(rootfs, 'app'))).toEqual(['upper'])
	})

	test('never writes or deletes through a symlink from a lower layer', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const outside = path.join(directory, 'outside')
		await mkdir(outside)
		await writeFile(path.join(outside, 'victim'), 'keep me')
		const rootfs = path.join(directory, 'rootfs')
		await mkdir(rootfs)
		await symlink(outside, path.join(rootfs, 'etc'))
		const archive = await layerArchive(directory, { 'etc/.wh.victim': '', 'etc/planted': 'planted' })

		// Act
		await applyLayer(archive, rootfs, timeout())

		// Assert
		expect(await readdir(outside)).toEqual(['victim'])
		expect((await lstat(path.join(rootfs, 'etc'))).isDirectory()).toBe(true)
		expect(existsSync(path.join(rootfs, 'etc', 'planted'))).toBe(true)
	})

	test.each(['.wh.', '.wh..', '.wh...'])('refuses the whiteout %j, which names no file', async (whiteout) => {
		// Arrange
		const directory = await temporaryDirectory()
		const rootfs = path.join(directory, 'rootfs')
		await mkdir(rootfs)
		await writeFile(path.join(rootfs, 'keep'), 'keep')
		const archive = await layerArchive(directory, { [`dir/${whiteout}`]: '' })

		// Act
		const applying = applyLayer(archive, rootfs, timeout())

		// Assert
		await expect(applying).rejects.toThrow('invalid whiteout')
		expect(existsSync(path.join(rootfs, 'keep'))).toBe(true)
	})
})
