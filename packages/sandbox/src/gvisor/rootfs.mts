import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)
const registry = 'https://registry-1.docker.io'
const marker = '.mesh-flow-image'

const Token = z.object({ token: z.string() })
const Index = z.object({
	manifests: z.array(
		z.object({
			digest: z.string(),
			platform: z.object({ architecture: z.string(), os: z.string() }).optional(),
		}),
	),
})
const Manifest = z.object({ layers: z.array(z.object({ digest: z.string() })) })

const accept = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** The directory an image is unpacked into: `node:22-slim` becomes `node_22-slim`. */
export function rootfsDirectory(images: string, image: string): string {
	return path.join(images, image.replaceAll(/[^\w.-]/g, '_'))
}

/**
 * Unpacks an image from Docker Hub into a root filesystem directory, without Docker, unless it's
 * already there. Returns the directory.
 *
 * Enough for official images like `node:22-slim`: the manifest for this machine's architecture,
 * then each layer in order with its whiteouts applied. Not a general OCI implementation. Needs GNU
 * tar, and runs as the user that should own the files (root, for runsc).
 */
export async function prepareRootfs(images: string, image: string, signal: AbortSignal): Promise<string> {
	const target = rootfsDirectory(images, image)
	if (existsSync(path.join(target, marker))) return target

	// Unpacked next to the target and renamed at the end, so a pull that stops halfway leaves
	// nothing that looks finished.
	const partial = `${target}.partial-${randomBytes(4).toString('hex')}`
	try {
		await mkdir(partial, { recursive: true })
		const { repository, tag } = parseImage(image)
		const token = await pullToken(repository, signal)
		for (const digest of await layerDigests(repository, tag, token, signal)) await unpackLayer(repository, digest, token, partial, signal)
		await writeFile(path.join(partial, marker), `${image}\n`)
		await rm(target, { recursive: true, force: true })
		await rename(partial, target)
		return target
	} finally {
		await rm(partial, { recursive: true, force: true })
		await rm(`${partial}.layer`, { recursive: true, force: true })
		await rm(`${partial}.tar`, { force: true })
	}
}

/** `node:22-slim` → `library/node` and `22-slim`. */
function parseImage(image: string): { repository: string; tag: string } {
	const [name = image, tag = 'latest'] = image.split(':')
	return { repository: name.includes('/') ? name : `library/${name}`, tag }
}

async function pullToken(repository: string, signal: AbortSignal): Promise<string> {
	const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`
	const response = await fetch(url, { signal })
	if (!response.ok) throw new Error(`Docker Hub refused a pull token for ${repository}: ${String(response.status)}`)
	return Token.parse(await response.json()).token
}

async function get(url: string, token: string, signal: AbortSignal, accepts = accept): Promise<Response> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: accepts }, signal })
	if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${response.statusText}`)
	return response
}

async function layerDigests(repository: string, tag: string, token: string, signal: AbortSignal): Promise<string[]> {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
	let body: unknown = await (await get(`${registry}/v2/${repository}/manifests/${tag}`, token, signal)).json()
	const index = Index.safeParse(body)
	if (index.success) {
		const match = index.data.manifests.find((entry) => entry.platform?.os === 'linux' && entry.platform.architecture === architecture)
		if (!match) throw new Error(`${repository}:${tag} has no linux/${architecture} image.`)
		body = await (await get(`${registry}/v2/${repository}/manifests/${match.digest}`, token, signal)).json()
	}
	return Manifest.parse(body).layers.map((layer) => layer.digest)
}

async function unpackLayer(repository: string, digest: string, token: string, rootfs: string, signal: AbortSignal): Promise<void> {
	const archive = `${rootfs}.tar`
	const scratch = `${rootfs}.layer`
	const blob = await get(`${registry}/v2/${repository}/blobs/${digest}`, token, signal, '*/*')
	if (!blob.body) throw new Error(`The layer ${digest} is empty.`)
	await pipeline(Readable.fromWeb(blob.body), createWriteStream(archive), { signal })

	await rm(scratch, { recursive: true, force: true })
	await mkdir(scratch)
	// tar detects gzip and zstd itself; --numeric-owner keeps the image's uids on any host.
	await run('tar', ['-xf', archive, '-C', scratch, '--numeric-owner', '--same-permissions'], { signal })
	await applyWhiteouts(scratch, rootfs)
	await run('cp', ['-a', `${scratch}/.`, rootfs], { signal })
	await rm(scratch, { recursive: true, force: true })
	await rm(archive)
}

/** Applies a layer's whiteouts to the layers below it, then drops them from the layer. */
async function applyWhiteouts(layer: string, rootfs: string, relative = ''): Promise<void> {
	for (const entry of await readdir(path.join(layer, relative), { withFileTypes: true })) {
		const inLayer = path.join(layer, relative, entry.name)
		if (entry.name === '.wh..wh..opq') {
			// An opaque directory: nothing from lower layers stays visible in it.
			await rm(path.join(rootfs, relative), { recursive: true, force: true })
			await rm(inLayer)
		} else if (entry.name.startsWith('.wh.')) {
			await rm(path.join(rootfs, relative, entry.name.slice('.wh.'.length)), { recursive: true, force: true })
			await rm(inLayer)
		} else if (entry.isDirectory()) {
			await applyWhiteouts(layer, rootfs, path.join(relative, entry.name))
		}
	}
}
