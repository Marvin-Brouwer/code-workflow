import { readFile, rm } from 'node:fs/promises'
import type { PackageRequest } from '@mesh-flow/protocol'
import { packageFetchThroughGateway } from '../gateway/gateway-packages.mts'
import { findScope } from '../run/run-scope.mts'

/** What {@link fetchPackage} fetches: a path on one of the app's registries, with the `accept` header to send. */
export type { PackageRequest }

/** What the registry answered. */
export interface FetchedPackage {
	readonly status: number
	/** `content-type`, `etag` and `last-modified`, when the registry sent them. */
	readonly headers: Readonly<Record<string, string>>
	readonly body: Buffer
}

/**
 * Fetches a package or its metadata from one of the registries the app's sandbox lists, through
 * the gateway: the same call the package proxy makes for `npm ci` or `dotnet restore`, for code
 * that wants a package itself. A 404 is an answer, not an error.
 *
 * ```ts
 * const PackageVersions = z.object({ versions: z.array(z.string()) })
 *
 * const request = {
 * 	registry: nugetOrg,
 * 	path: '/v3-flatcontainer/newtonsoft.json/index.json',
 * }
 * const index = await fetchPackage(request, abortSignal)
 * const { versions } = PackageVersions.parse(JSON.parse(index.body.toString('utf8')))
 * ```
 *
 * @throws Outside a run with a gateway, when the app doesn't list the registry, and when the path
 * isn't a package fetch.
 */
export async function fetchPackage(request: PackageRequest, abortSignal: AbortSignal): Promise<FetchedPackage> {
	const gateway = findScope()?.run.gateway
	if (gateway === undefined) throw new Error('Packages come through the gateway, and this run has none.')
	const answer = await packageFetchThroughGateway(gateway)(request, abortSignal)
	try {
		return { status: answer.status, headers: answer.headers, body: await readFile(answer.file, { signal: abortSignal }) }
	} finally {
		await rm(answer.file, { force: true })
	}
}
