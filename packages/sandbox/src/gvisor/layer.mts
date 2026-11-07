import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const whiteoutPrefix = '.wh.'
const opaqueWhiteout = '.wh..wh..opq'

/**
 * Unpacks one image layer onto the root filesystem of the layers below it, the way overlayfs
 * stacks them: whiteouts delete from below, and a directory replaces anything below that isn't
 * one, a symlink included. So nothing is ever written through a symlink from an earlier layer,
 * which could point anywhere on the host.
 *
 * GNU tar unpacks the layer itself, and refuses entries that go through a symlink in the same
 * layer. It detects gzip and zstd on its own.
 */
export async function applyLayer(archive: string, rootfs: string, signal: AbortSignal): Promise<void> {
	const layer = `${rootfs}.layer`
	await rm(layer, { recursive: true, force: true })
	await mkdir(layer)
	try {
		// --numeric-owner keeps the image's uids on any host.
		await execFileAsync('tar', ['-xf', archive, '-C', layer, '--numeric-owner', '--same-permissions'], { signal })
		await prepareMerge(layer, rootfs)
		// --remove-destination: a symlink below is replaced, never written through.
		await execFileAsync('cp', ['-a', '--remove-destination', `${layer}/.`, rootfs], { signal })
	} finally {
		await rm(layer, { recursive: true, force: true })
	}
}

/** Applies whiteouts and clears what the layer replaces, so a plain copy finishes the merge. */
async function prepareMerge(layer: string, rootfs: string, relative = ''): Promise<void> {
	const here = path.join(layer, relative)
	const below = path.join(rootfs, relative)
	const entries = await readdir(here, { withFileTypes: true })

	if (entries.some((entry) => entry.name === opaqueWhiteout)) {
		// An opaque directory: nothing from lower layers stays visible in it.
		await emptyDirectory(below)
		await rm(path.join(here, opaqueWhiteout))
	}
	for (const entry of entries) {
		if (entry.name === opaqueWhiteout) continue
		const inLayer = path.join(here, entry.name)
		const target = path.join(below, entry.name)
		if (entry.name.startsWith(whiteoutPrefix)) {
			await rm(path.join(below, whiteoutTarget(entry.name)), { recursive: true, force: true })
			await rm(inLayer)
			continue
		}
		const existing = await lstat(target).catch(() => undefined)
		if (entry.isDirectory()) {
			if (existing !== undefined && !existing.isDirectory()) await rm(target, { force: true })
			await prepareMerge(layer, rootfs, path.join(relative, entry.name))
		} else if (existing?.isDirectory()) {
			await rm(target, { recursive: true, force: true })
		}
	}
}

/** `.wh.name` deletes `name`. Refuses names that would reach the directory itself or above it. */
function whiteoutTarget(entry: string): string {
	const name = entry.slice(whiteoutPrefix.length)
	if (name === '' || name === '.' || name === '..') throw new Error(`The image layer has an invalid whiteout: ${entry}`)
	return name
}

async function emptyDirectory(directory: string): Promise<void> {
	const existing = await lstat(directory).catch(() => undefined)
	if (!existing?.isDirectory()) return
	for (const entry of await readdir(directory)) await rm(path.join(directory, entry), { recursive: true, force: true })
}
