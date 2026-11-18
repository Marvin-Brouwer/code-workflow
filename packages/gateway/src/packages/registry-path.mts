import { servedPrefixLength, type PackageRegistry } from '@mesh-flow/protocol'

/**
 * Whether `path`, with its query, is a package fetch on `registry`: on its host, and the same once
 * read as a URL (no `..` or fragment), so nothing past the check can turn it into another path.
 * `servedPrefixLength` checks the rest: below one of its paths and none of its excluded ones, also
 * once escapes are decoded, and no `//`.
 */
export function isRegistryPath(registry: PackageRegistry, path: string): boolean {
	const url = new URL(path, `https://${registry.host}`)
	return url.host === registry.host && `${url.pathname}${url.search}` === path && servedPrefixLength(registry, url.pathname) !== undefined
}
