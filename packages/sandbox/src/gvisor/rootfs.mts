import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { abortable } from '../abortable.mts'
import type { BackendLifetime } from '../backend-lifetime.mts'
import { blob, download, openRepository, parseImage, platformManifest } from './docker-hub.mts'
import { applyLayer } from './layer.mts'

/** Written last into an unpacked image, so a directory without it is never used. */
export const imageMarker = '.mesh-flow-image'

/** An unpacked image: its root filesystem and what its config says a process starts with. */
export interface Rootfs {
	readonly path: string
	/** `KEY=value` entries from the image config, `PATH` among them. */
	readonly env: readonly string[]
	readonly workingDir: string
}

/** What the marker holds. */
const ImageInfo = z.object({ image: z.string(), env: z.array(z.string()), workingDir: z.string() })
type ImageInfo = z.infer<typeof ImageInfo>

const ImageConfig = z.object({
	config: z.object({ Env: z.array(z.string()).nullish(), WorkingDir: z.string().nullish() }).nullish(),
})

/**
 * The images a gVisor backend has unpacked. One pull per image at a time, shared by every caller
 * and stopped only by close, which waits for it to clean up.
 */
export class RootfsCache {
	readonly #images: string
	readonly #lifetime: BackendLifetime
	readonly #pulls = new Map<string, Promise<Rootfs>>()
	#swept: Promise<void> | undefined

	constructor(images: string, lifetime: BackendLifetime) {
		this.#images = images
		this.#lifetime = lifetime
	}

	get(image: string, signal: AbortSignal): Promise<Rootfs> {
		let pull = this.#pulls.get(image)
		if (pull === undefined) {
			this.#swept ??= removeUnfinishedPulls(this.#images)
			const swept = this.#swept
			pull = this.#lifetime.keep(swept.then(() => prepareRootfs(this.#images, image, this.#lifetime.closing)))
			this.#pulls.set(image, pull)
			pull.catch(() => this.#pulls.delete(image))
		}
		return abortable(pull, signal)
	}
}

/** The directory an image is unpacked into: readable, with a hash so no two images share one. */
export function rootfsDirectory(images: string, image: string): string {
	const hash = createHash('sha256').update(image).digest('hex').slice(0, 8)
	return path.join(images, `${image.replaceAll(/[^\w.-]/g, '_')}-${hash}`)
}

/**
 * Unpacks an image from Docker Hub into a root filesystem directory, without Docker, unless it's
 * already there.
 *
 * Enough for official images like `node:26-slim`: the manifest for this machine's architecture,
 * each layer in order, checked against its digest, and the config's `Env` and `WorkingDir`. Not a
 * general OCI implementation. Needs GNU tar. The files belong to the user the engine runs as.
 */
export async function prepareRootfs(images: string, image: string, signal: AbortSignal): Promise<Rootfs> {
	const target = rootfsDirectory(images, image)
	const existing = await readImageInfo(target)
	if (existing !== undefined) return rootfsOf(target, existing)

	// Unpacked next to the target and renamed at the end, so a pull that stops halfway leaves
	// nothing that looks finished.
	const partial = `${target}.partial-${randomBytes(4).toString('hex')}`
	const archive = `${partial}.tar`
	try {
		await mkdir(partial, { recursive: true })
		const { name, reference } = parseImage(image)
		const repository = await openRepository(name, signal)
		const manifest = await platformManifest(repository, reference, signal)
		for (const layer of manifest.layers) {
			await download(repository, layer.digest, archive, signal)
			await applyLayer(archive, partial, signal)
		}
		const { config } = ImageConfig.parse(JSON.parse((await blob(repository, manifest.config.digest, signal)).toString('utf8')))
		const info: ImageInfo = { image, env: config?.Env ?? [], workingDir: nonEmpty(config?.WorkingDir) ?? '/' }
		await writeFile(path.join(partial, imageMarker), JSON.stringify(info))
		await rm(target, { recursive: true, force: true })
		await rename(partial, target)
		return rootfsOf(target, info)
	} finally {
		await rm(partial, { recursive: true, force: true })
		await rm(archive, { force: true })
	}
}

function rootfsOf(target: string, info: ImageInfo): Rootfs {
	return { path: target, env: info.env, workingDir: info.workingDir }
}

/** Image configs leave `WorkingDir` out, or set it to `''`, when it's the root. */
function nonEmpty(value: string | null | undefined): string | undefined {
	return value === null || value === '' ? undefined : value
}

/** The marker of an unpacked image. A missing or unreadable one means: unpack it again. */
async function readImageInfo(target: string): Promise<ImageInfo | undefined> {
	const marker = path.join(target, imageMarker)
	if (!existsSync(marker)) return undefined
	try {
		return ImageInfo.parse(JSON.parse(await readFile(marker, 'utf8')))
	} catch {
		return undefined
	}
}

/** What a pull that was killed left behind. Runs once, before the first pull of a backend. */
async function removeUnfinishedPulls(images: string): Promise<void> {
	if (!existsSync(images)) return
	for (const entry of await readdir(images)) {
		if (entry.includes('.partial-')) await rm(path.join(images, entry), { recursive: true, force: true })
	}
}
