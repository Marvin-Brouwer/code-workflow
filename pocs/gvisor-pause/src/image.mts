/**
 * Turns an image from Docker Hub into a root filesystem directory, without Docker: fetch the
 * manifest for this machine's architecture, then unpack each layer in order and apply its
 * whiteouts. Enough for official images like node:22-slim; not a general OCI implementation.
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

const registry = 'https://registry-1.docker.io'

const Token = z.object({ token: z.string() })
const Index = z.object({
	manifests: z.array(
		z.object({
			digest: z.string(),
			platform: z.object({ architecture: z.string(), os: z.string() }).optional(),
		}),
	),
})
const Manifest = z.object({ layers: z.array(z.object({ digest: z.string(), mediaType: z.string() })) })

const accept = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'

/** `node:22-slim` → `library/node` and `22-slim`. */
function parse(image: string) {
	const [name = image, tag = 'latest'] = image.split(':')
	return { repository: name.includes('/') ? name : `library/${name}`, tag }
}

async function get(url: string, token: string, signal: AbortSignal, accepts = accept) {
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: accepts }, signal })
	if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${response.statusText}`)
	return response
}

/** Applies a layer's whiteouts to the root filesystem below it, then removes them from the layer. */
function applyWhiteouts(layerDir: string, rootfs: string, relative = '') {
	for (const entry of readdirSync(path.join(layerDir, relative), { withFileTypes: true })) {
		const inLayer = path.join(layerDir, relative, entry.name)
		if (entry.name === '.wh..wh..opq') {
			// Opaque directory: nothing from lower layers stays visible in it.
			rmSync(path.join(rootfs, relative), { recursive: true, force: true })
			rmSync(inLayer)
		} else if (entry.name.startsWith('.wh.')) {
			rmSync(path.join(rootfs, relative, entry.name.slice('.wh.'.length)), { recursive: true, force: true })
			rmSync(inLayer)
		} else if (entry.isDirectory() && !entry.isSymbolicLink()) {
			applyWhiteouts(layerDir, rootfs, path.join(relative, entry.name))
		}
	}
}

/**
 * Unpacks `image` into `rootfs`, unless `rootfs` already holds it. Returns the manifest digest.
 * Needs GNU tar; runs as the user that will own the files (root for runsc).
 */
export async function pullRootfs(image: string, rootfs: string, signal: AbortSignal): Promise<string> {
	const marker = path.join(rootfs, '.poc-image')
	if (existsSync(marker)) return 'cached'

	const { repository, tag } = parse(image)
	const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`
	const tokenResponse = await fetch(tokenUrl, { signal })
	if (!tokenResponse.ok) throw new Error(`Docker Hub token: ${String(tokenResponse.status)}`)
	const { token } = Token.parse(await tokenResponse.json())

	const top = await get(`${registry}/v2/${repository}/manifests/${tag}`, token, signal)
	let body: unknown = await top.json()
	const index = Index.safeParse(body)
	if (index.success) {
		const match = index.data.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === architecture)
		if (!match) throw new Error(`${image} has no linux/${architecture} image`)
		body = await (await get(`${registry}/v2/${repository}/manifests/${match.digest}`, token, signal)).json()
	}
	const manifest = Manifest.parse(body)

	rmSync(rootfs, { recursive: true, force: true })
	mkdirSync(rootfs, { recursive: true })
	const scratch = `${rootfs}.layer`
	for (const [number, layer] of manifest.layers.entries()) {
		console.log(`     layer ${String(number + 1)}/${String(manifest.layers.length)} ${layer.digest.slice(0, 19)}`)
		const blob = await get(`${registry}/v2/${repository}/blobs/${layer.digest}`, token, signal, '*/*')
		if (!blob.body) throw new Error(`empty layer ${layer.digest}`)
		const archive = `${scratch}.tar`
		await pipeline(Readable.fromWeb(blob.body), createWriteStream(archive), { signal })

		rmSync(scratch, { recursive: true, force: true })
		mkdirSync(scratch)
		// tar detects gzip and zstd itself; --numeric-owner keeps the image's uids on any host.
		execFileSync('tar', ['-xf', archive, '-C', scratch, '--numeric-owner', '--same-permissions'])
		applyWhiteouts(scratch, rootfs)
		execFileSync('cp', ['-a', `${scratch}/.`, rootfs])
		rmSync(scratch, { recursive: true, force: true })
		rmSync(archive)
	}
	writeFileSync(marker, `${image}\n`)
	return manifest.layers.map((layer) => layer.digest).join(',')
}
