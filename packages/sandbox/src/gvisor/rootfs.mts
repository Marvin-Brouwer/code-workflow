import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { abortable } from '../abortable.mts'
import type { BackendLifetime } from '../backend-lifetime.mts'
import { applyLayer } from './layer.mts'

const registry = 'https://registry-1.docker.io'

/** Written last into an unpacked image, so a directory without it is never used. */
export const imageMarker = '.mesh-flow-image'

/** An unpacked image: its root filesystem and what its config says a process starts with. */
export interface Rootfs {
	readonly path: string
	/** `KEY=value` entries from the image config, `PATH` among them. */
	readonly env: readonly string[]
	readonly workingDir: string
}

const ImageInfo = z.object({ image: z.string(), env: z.array(z.string()), workingDir: z.string() })
type ImageInfo = z.infer<typeof ImageInfo>

const Token = z.object({ token: z.string() })
const Index = z.object({
	manifests: z.array(
		z.object({
			digest: z.string(),
			platform: z.object({ architecture: z.string(), os: z.string() }).optional(),
		}),
	),
})
const Manifest = z.object({ config: z.object({ digest: z.string() }), layers: z.array(z.object({ digest: z.string() })) })
const ImageConfig = z.object({
	config: z.object({ Env: z.array(z.string()).nullish(), WorkingDir: z.string().nullish() }).nullish(),
})

const manifestMediaTypes = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

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
 * Enough for official images like `node:22-slim`: the manifest for this machine's architecture,
 * each layer in order, checked against its digest, and the config's `Env` and `WorkingDir`. Not a
 * general OCI implementation. Needs GNU tar. The files belong to the user the engine runs as.
 */
export async function prepareRootfs(images: string, image: string, signal: AbortSignal): Promise<Rootfs> {
	const target = rootfsDirectory(images, image)
	const existing = await readImageInfo(target)
	if (existing !== undefined) return { path: target, env: existing.env, workingDir: existing.workingDir }

	// Unpacked next to the target and renamed at the end, so a pull that stops halfway leaves
	// nothing that looks finished.
	const partial = `${target}.partial-${randomBytes(4).toString('hex')}`
	const archive = `${partial}.tar`
	try {
		await mkdir(partial, { recursive: true })
		const { repository, reference } = parseImage(image)
		const token = await pullToken(repository, signal)
		const manifest = await platformManifest(repository, reference, token, signal)
		for (const layer of manifest.layers) {
			await download(repository, layer.digest, token, archive, signal)
			await applyLayer(archive, partial, signal)
		}
		const config = ImageConfig.parse(JSON.parse((await blob(repository, manifest.config.digest, token, signal)).toString('utf8')))
		const info: ImageInfo = { image, env: config.config?.Env ?? [], workingDir: nonEmpty(config.config?.WorkingDir) ?? '/' }
		await writeFile(path.join(partial, imageMarker), JSON.stringify(info))
		await rm(target, { recursive: true, force: true })
		await rename(partial, target)
		return { path: target, env: info.env, workingDir: info.workingDir }
	} finally {
		await rm(partial, { recursive: true, force: true })
		await rm(archive, { force: true })
	}
}

/**
 * `node:22-slim` → `library/node` and `22-slim`; `node@sha256:…` → `library/node` and the digest.
 * Docker Hub only: a reference that names another registry is refused.
 */
export function parseImage(image: string): { repository: string; reference: string } {
	const [nameAndTag = image, digest] = image.split('@')
	const colon = nameAndTag.lastIndexOf(':')
	const hasTag = colon > nameAndTag.lastIndexOf('/')
	const name = hasTag ? nameAndTag.slice(0, colon) : nameAndTag
	const [first = '', ...rest] = name.split('/')
	if (rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
		throw new Error(`Only Docker Hub images are supported on gVisor, not ${image}.`)
	}
	return {
		repository: rest.length > 0 ? name : `library/${name}`,
		reference: digest ?? (hasTag ? nameAndTag.slice(colon + 1) : 'latest'),
	}
}

/** Image configs leave `WorkingDir` out, or set it to `''`, when it's the root. */
function nonEmpty(value: string | null | undefined): string | undefined {
	return value === null || value === '' ? undefined : value
}

async function readImageInfo(target: string): Promise<ImageInfo | undefined> {
	const marker = path.join(target, imageMarker)
	if (!existsSync(marker)) return undefined
	const parsed = ImageInfo.safeParse(JSON.parse(await readFile(marker, 'utf8')))
	return parsed.success ? parsed.data : undefined
}

/** What a pull that was killed left behind. Runs once, before the first pull of a backend. */
async function removeUnfinishedPulls(images: string): Promise<void> {
	if (!existsSync(images)) return
	for (const entry of await readdir(images)) {
		if (entry.includes('.partial-')) await rm(path.join(images, entry), { recursive: true, force: true })
	}
}

async function pullToken(repository: string, signal: AbortSignal): Promise<string> {
	const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`
	const response = await fetch(url, { signal })
	if (!response.ok) throw new Error(`Docker Hub refused a pull token for ${repository}: ${String(response.status)}`)
	return Token.parse(await response.json()).token
}

async function get(url: string, token: string, signal: AbortSignal, accept: string): Promise<Response> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept }, signal })
	if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${response.statusText}`)
	return response
}

async function platformManifest(
	repository: string,
	reference: string,
	token: string,
	signal: AbortSignal,
): Promise<z.infer<typeof Manifest>> {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
	const manifestUrl = (ref: string) => `${registry}/v2/${repository}/manifests/${ref}`
	let body: unknown = await (await get(manifestUrl(reference), token, signal, manifestMediaTypes)).json()
	const index = Index.safeParse(body)
	if (index.success) {
		const match = index.data.manifests.find((entry) => entry.platform?.os === 'linux' && entry.platform.architecture === architecture)
		if (!match) throw new Error(`${repository}:${reference} has no linux/${architecture} image.`)
		body = await (await get(manifestUrl(match.digest), token, signal, manifestMediaTypes)).json()
	}
	return Manifest.parse(body)
}

function blobUrl(repository: string, digest: string): string {
	return `${registry}/v2/${repository}/blobs/${digest}`
}

/** A small blob, such as the image config, checked against its digest. */
async function blob(repository: string, digest: string, token: string, signal: AbortSignal): Promise<Buffer> {
	const content = Buffer.from(await (await get(blobUrl(repository, digest), token, signal, '*/*')).arrayBuffer())
	assertDigest(digest, createHash('sha256').update(content).digest('hex'))
	return content
}

/** A layer, streamed to `file` and checked against its digest. */
async function download(repository: string, digest: string, token: string, file: string, signal: AbortSignal): Promise<void> {
	const response = await get(blobUrl(repository, digest), token, signal, '*/*')
	if (!response.body) throw new Error(`The layer ${digest} is empty.`)
	const hash = createHash('sha256')
	const hashing = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			hash.update(chunk)
			done(null, chunk)
		},
	})
	await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(file), { signal })
	assertDigest(digest, hash.digest('hex'))
}

function assertDigest(expected: string, sha256: string): void {
	if (expected !== `sha256:${sha256}`) throw new Error(`The blob ${expected} came in with the digest sha256:${sha256}.`)
}
