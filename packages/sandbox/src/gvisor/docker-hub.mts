import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
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
const Manifest = z.object({ config: z.object({ digest: z.string() }), layers: z.array(z.object({ digest: z.string() })) })
export type Manifest = z.infer<typeof Manifest>

const manifestMediaTypes = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** One image on Docker Hub, with the pull token every request needs. */
export interface Repository {
	readonly name: string
	readonly token: string
}

/**
 * `node:22-slim` → `library/node` and `22-slim`; `node@sha256:…` → `library/node` and the digest.
 * Docker Hub only: a reference that names another registry is refused.
 */
export function parseImage(image: string): { name: string; reference: string } {
	const [nameAndTag = image, digest] = image.split('@')
	const colon = nameAndTag.lastIndexOf(':')
	const hasTag = colon > nameAndTag.lastIndexOf('/')
	const name = hasTag ? nameAndTag.slice(0, colon) : nameAndTag
	const [first = '', ...rest] = name.split('/')
	if (rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
		throw new Error(`Only Docker Hub images are supported on gVisor, not ${image}.`)
	}
	return {
		name: rest.length > 0 ? name : `library/${name}`,
		reference: digest ?? (hasTag ? nameAndTag.slice(colon + 1) : 'latest'),
	}
}

/** An anonymous pull token for one repository. */
export async function openRepository(name: string, signal: AbortSignal): Promise<Repository> {
	const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${name}:pull`
	const response = await fetch(url, { signal })
	if (!response.ok) throw new Error(`Docker Hub refused a pull token for ${name}: ${String(response.status)}`)
	return { name, token: Token.parse(await response.json()).token }
}

/** The manifest for this machine's architecture, also when the reference names an index. */
export async function platformManifest(repository: Repository, reference: string, signal: AbortSignal): Promise<Manifest> {
	const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
	const manifestUrl = (ref: string) => `${registry}/v2/${repository.name}/manifests/${ref}`
	let body: unknown = await (await get(repository, manifestUrl(reference), signal, manifestMediaTypes)).json()
	const index = Index.safeParse(body)
	if (index.success) {
		const match = index.data.manifests.find((entry) => entry.platform?.os === 'linux' && entry.platform.architecture === architecture)
		if (!match) throw new Error(`${repository.name}:${reference} has no linux/${architecture} image.`)
		body = await (await get(repository, manifestUrl(match.digest), signal, manifestMediaTypes)).json()
	}
	return Manifest.parse(body)
}

/** A small blob, such as the image config, checked against its digest. */
export async function blob(repository: Repository, digest: string, signal: AbortSignal): Promise<Buffer> {
	const content = Buffer.from(await (await get(repository, blobUrl(repository, digest), signal, '*/*')).arrayBuffer())
	assertDigest(digest, createHash('sha256').update(content).digest('hex'))
	return content
}

/** A blob such as a layer, streamed to `file` and checked against its digest. */
export async function download(repository: Repository, digest: string, file: string, signal: AbortSignal): Promise<void> {
	const response = await get(repository, blobUrl(repository, digest), signal, '*/*')
	if (!response.body) throw new Error(`The blob ${digest} is empty.`)
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

async function get(repository: Repository, url: string, signal: AbortSignal, accept: string): Promise<Response> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${repository.token}`, accept }, signal })
	if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${response.statusText}`)
	return response
}

function blobUrl(repository: Repository, digest: string): string {
	return `${registry}/v2/${repository.name}/blobs/${digest}`
}

function assertDigest(expected: string, sha256: string): void {
	if (expected !== `sha256:${sha256}`) throw new Error(`The blob ${expected} came in with the digest sha256:${sha256}.`)
}
