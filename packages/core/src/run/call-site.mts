import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCallSites } from 'node:util'
import { sourceSite } from './source-site.mts'
import { toPosix } from './to-posix.mts'

/** Where a function was called from. */
export interface CallSite {
	/** Absolute path of the file. */
	readonly file: string
	readonly line: number
	readonly column: number
}

/**
 * The call site `above` frames up from the function that calls this: `callSite(1)` in `loop` is
 * where `loop` was called. Uses Node's structured call sites, so it doesn't parse stack text.
 */
export function callSite(above: number): CallSite | undefined {
	// Frame 0 is this function, frame 1 the one that called it.
	const site = getCallSites(above + 2)[above + 1]
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
	const source = sourceSite(site)
	if (source !== undefined) return `${source.file}:${source.line}:${source.column}`
	const file = toPosix(path.relative(process.cwd(), site.file))
	return `${file}:${site.line}:${site.column}`
}
