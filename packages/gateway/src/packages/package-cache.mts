import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { registryKey, type PackageRequest } from '@mesh-flow/protocol'
import { z } from 'zod'
import type { RegistryAnswer } from './fetch-from-public-registry.mts'
import { replaceFile } from '../files/replace-file.mts'

/**
 * The packages every run on the gateway has fetched, on the host: a published version doesn't
 * change, so a cached one is always right, and a warm restore only waits on the mailbox.
 */
export interface PackageCache {
	/**
	 * The cached answer to `request`, if it's a package that was fetched before. An entry that can't
	 * be read, such as a damaged one, is a miss: the package is fetched again and the entry written anew.
	 */
	readonly get: (request: PackageRequest, abortSignal: AbortSignal) => Promise<RegistryAnswer | undefined>
	/**
	 * Keeps the answer to `request` when it's a package that was fetched whole. Version lists and
	 * metadata aren't kept. Only rejects when aborted: a package that can't be kept, such as on a
	 * full disk, was still fetched, and the next fetch tries to keep it again.
	 */
	readonly put: (request: PackageRequest, fetched: RegistryAnswer, abortSignal: AbortSignal) => Promise<void>
}

/** What the cache keeps next to a package's body. */
const CachedHeaders = z.record(z.string(), z.string())

/** The status of a package that was fetched whole: the only answer kept. */
const wholePackageStatus = 200

/** A base for reading a request's path as a URL: only the path is read, never the origin. */
const anyOrigin = 'https://registry.invalid'

/** How many characters of the key name the folder a package is in, so no folder holds too many files. */
const shardPrefixLength = 2

/**
 * Whether `request` fetches a published package, which never changes: a NuGet `.nupkg` or an npm
 * tarball, on any registry. Everything else, such as a version list, is fetched again each time.
 */
export function isPackageDownload(request: PackageRequest): boolean {
	const pathname = new URL(request.path, anyOrigin).pathname.toLowerCase()
	return pathname.endsWith('.nupkg') || pathname.endsWith('.tgz')
}

/**
 * Opens the cache in `directory`, made on the first write. Each package is a body and its headers,
 * by a hash of the registry, the path and the `accept` header, each written whole, so runs reading
 * it while another writes see the old one or the new one.
 */
export function openPackageCache(directory: string): PackageCache {
	const filesOf = (request: PackageRequest) => {
		const key = createHash('sha256')
			.update(JSON.stringify([registryKey(request.registry), request.path, request.accept ?? '']))
			.digest('hex')
		const base = path.join(directory, key.slice(0, shardPrefixLength), key)
		return { body: `${base}.body`, headers: `${base}.json` }
	}
	return Object.freeze<PackageCache>({
		async get(request, abortSignal) {
			if (!isPackageDownload(request)) return undefined
			const files = filesOf(request)
			try {
				// Headers last: they are written last, so with them the body is whole.
				const headers = CachedHeaders.parse(JSON.parse(await readFile(files.headers, { encoding: 'utf8', signal: abortSignal })))
				return { status: wholePackageStatus, headers, body: await readFile(files.body, { signal: abortSignal }) }
			} catch {
				abortSignal.throwIfAborted()
				return undefined
			}
		},
		async put(request, fetched, abortSignal) {
			if (fetched.status !== wholePackageStatus || !isPackageDownload(request)) return
			abortSignal.throwIfAborted()
			const files = filesOf(request)
			try {
				await mkdir(path.dirname(files.body), { recursive: true, mode: 0o700 })
				await replaceFile(files.body, fetched.body, { mode: 0o600, abortSignal })
				await replaceFile(files.headers, JSON.stringify(fetched.headers), { mode: 0o600, abortSignal })
			} catch {
				abortSignal.throwIfAborted()
			}
		},
	})
}
