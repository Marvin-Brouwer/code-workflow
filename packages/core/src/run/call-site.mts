import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCallSites } from 'node:util'
import { sourcePlace } from './source-site.mts'
import { toPosix } from './to-posix.mts'

/** Where a function was called from. */
export interface CallSite {
	/** Absolute path of the file that runs, which is the bundle in a built app. */
	readonly file: string
	readonly line: number
	readonly column: number
}

/**
 * The call site `above` frames up from the function that calls this: `callSite(1)` in `loop` is
 * where `loop` was called. Uses Node's structured call sites, so it doesn't parse stack text.
 */
export function callSite(above: number): CallSite | undefined {
	// Frame 0 is this function, frame 1 the one that called it. Mapped by `callSiteText` instead,
	// so `--enable-source-maps` doesn't change a loop's key.
	const site = getCallSites(above + 2, { sourceMap: false })[above + 1]
	if (site === undefined || site.scriptName === '') return undefined
	const file = site.scriptName.startsWith('file:') ? fileURLToPath(site.scriptName) : site.scriptName
	return { file, line: site.lineNumber, column: site.columnNumber }
}

/**
 * A call site as text that stays the same on every machine and across rebuilds. In a bundle with a
 * source map, it's the place in the source, as the map names the file; otherwise the file relative
 * to the working directory.
 */
export function callSiteText(site: CallSite | undefined): string {
	if (site === undefined) return 'unknown'
	const place = sourcePlace(site) ?? { ...site, file: toPosix(path.relative(process.cwd(), site.file)) }
	return `${place.file}:${place.line}:${place.column}`
}
