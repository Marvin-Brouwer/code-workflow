import type { PackageRegistry } from './package-registry.mts'

/** A character a path may hold escaped that servers may read as the character itself: unreserved ones, `/` and `\`. */
const decodableCharacter = /^[\w.~/\\-]$/

/**
 * `path` as a server that decodes escapes may read it: `%2D` as `-`, `%2F` as `/`. Other escapes,
 * such as `%40`, stay as they are.
 */
function decodedPath(path: string): string {
	return path.replaceAll(/%([\da-f]{2})/gi, (escaped, hex: string) => {
		const character = String.fromCharCode(Number.parseInt(hex, 16))
		return decodableCharacter.test(character) ? character : escaped
	})
}

/** Whether a decoded path has a segment a server could resolve elsewhere: `.`, `..`, an empty one, or a `\`. */
function resolvesElsewhere(path: string): boolean {
	return path.includes('\\') || path.includes('//') || /\/\.{1,2}(?:\/|$)/.test(path)
}

/**
 * The length of the longest of the registry's paths that `path` is below, or `undefined` when it
 * isn't a package fetch on the registry: below none of its paths, or below an excluded one. A path
 * itself, such as `/` of the npm registry, isn't below it, and a path below one only once decoded,
 * such as `/v3%2Dflatcontainer/`, isn't either. The query doesn't count, and an escaped `%` is refused. The path is
 * read as a server that decodes escapes would, so `/%2D/whoami` is below `/-/`, and excluded paths
 * are compared without regard to case, so a server that ignores case can't reach one.
 */
export function servedPrefixLength(registry: PackageRegistry, path: string): number | undefined {
	const [rawPathname = ''] = path.split('?', 1)
	// An escaped `%` could decode a second time, on a server that decodes twice.
	if (/%25/i.test(rawPathname)) return undefined
	const pathname = decodedPath(rawPathname)
	if (resolvesElsewhere(pathname)) return undefined
	const lowerPathname = pathname.toLowerCase()
	if ((registry.excludedPaths ?? []).some((prefix) => lowerPathname.startsWith(prefix.toLowerCase()))) return undefined
	// Below a path as sent and as decoded, so a server that decodes escapes and one that doesn't agree.
	const isBelow = (prefix: string) => pathname.length > prefix.length && pathname.startsWith(prefix) && rawPathname.startsWith(prefix)
	const lengths = registry.paths.filter(isBelow).map((prefix) => prefix.length)
	return lengths.length === 0 ? undefined : Math.max(...lengths)
}
