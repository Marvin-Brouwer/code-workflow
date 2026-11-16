import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { registryKey, type PackageRequest } from '@mesh-flow/protocol'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'
import type { FetchedPackage } from './fetch-package.mts'

/**
 * The packages every run on the gateway has fetched, on the host: a published version doesn't
 * change, so a cached one is always right, and a warm restore only waits on the mailbox.
 */
export interface PackageCache {
	/** The cached answer to `request`, if it's a package that was fetched before. */
	readonly get: (request: PackageRequest, abortSignal: AbortSignal) => Promise<FetchedPackage | undefined>
	/** Keeps the answer to `request` when it's a package that was fetched whole. Version lists and metadata aren't kept. */
	readonly put: (request: PackageRequest, fetched: FetchedPackage, abortSignal: AbortSignal) => Promise<void>
}

/** What the cache keeps next to a package's body. */
const CachedHeaders = z.record(z.string(), z.string())

/** The status of a package that was fetched whole: the only answer kept. */
const ok = 200

/**
 * Whether `request` fetches a published package, which never changes: a NuGet `.nupkg` or an npm
 * tarball, on any registry. Everything else, such as a version list, is fetched again each time.
 */
export function isPackageDownload(request: PackageRequest): boolean {
	const pathname = new URL(request.path, 'https://registry.invalid').pathname.toLowerCase()
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
		const base = path.join(directory, key.slice(0, 2), key)
		return { body: `${base}.body`, headers: `${base}.json` }
	}
	return Object.freeze<PackageCache>({
		async get(request, abortSignal) {
			if (!isPackageDownload(request)) return undefined
			const files = filesOf(request)
			try {
				// Headers last: they are written last, so with them the body is whole.
				const headers = CachedHeaders.parse(JSON.parse(await readFile(files.headers, { encoding: 'utf8', signal: abortSignal })))
				return { status: ok, headers, body: await readFile(files.body, { signal: abortSignal }) }
			} catch (error) {
				if (hasErrorCode(error, 'ENOENT')) return undefined
				throw error
			}
		},
		async put(request, fetched, abortSignal) {
			if (fetched.status !== ok || !isPackageDownload(request)) return
			abortSignal.throwIfAborted()
			const files = filesOf(request)
			await mkdir(path.dirname(files.body), { recursive: true, mode: 0o700 })
			await writeFileAtomic(files.body, fetched.body, { mode: 0o600 })
			await writeFileAtomic(files.headers, JSON.stringify(fetched.headers), { mode: 0o600 })
		},
	})
}
