import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCallSites } from 'node:util'

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

/** A call site as text that stays the same on every machine: the file relative to the working directory. */
export function callSiteText(site: CallSite | undefined): string {
	if (site === undefined) return 'unknown'
	const file = path.relative(process.cwd(), site.file).split(path.sep).join('/')
	return `${file}:${site.line}:${site.column}`
}
