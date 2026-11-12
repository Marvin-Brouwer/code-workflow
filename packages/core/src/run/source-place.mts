import { readFileSync } from 'node:fs'
import { SourceMap, type SourceMapPayload } from 'node:module'
import { appSourceMapMarker } from '@mesh-flow/protocol'
import type { CallSite } from './call-site.mts'
import { hasErrorCode } from './has-error-code.mts'

/** A place in an app's source, with the file as the build's source map names it: relative to the repository. */
export interface SourcePlace {
	readonly file: string
	readonly line: number
	readonly column: number
}

/** Each call site's place in the source once looked up, or `undefined` when it has none. A bundle doesn't change while it runs. */
const places = new Map<string, SourcePlace | undefined>()

/** Bundles without the build's source map next to them, so they aren't read again. */
const unmapped = new Set<string>()

/** Source maps that couldn't be read, by bundle: asking again throws the same error. */
const unreadable = new Map<string, Error>()

/**
 * The bundle's decoded source map, kept only until the current task is done: calls made together,
 * such as `as()` while the app loads, decode it once, and the run doesn't carry it after.
 */
let decoded: { readonly bundle: string; readonly map: SourceMap } | undefined

/**
 * Where `site` is in the app's source, when its file is a bundle with the source map `mesh-flow
 * build` writes next to it (`main.mjs.map`), so a rebuild that moves the bundle's lines keeps the
 * place. `undefined` without that map, or when the map has nothing on the site's line.
 */
export function sourcePlace(site: CallSite): SourcePlace | undefined {
	const key = `${site.file}:${site.line}:${site.column}`
	if (!places.has(key)) places.set(key, lookUp(site))
	return places.get(key)
}

function lookUp(site: CallSite): SourcePlace | undefined {
	const map = appSourceMap(site.file)
	if (map === undefined) return undefined
	const generatedLine = site.line - 1
	const generatedColumn = site.column - 1
	const entry = map.findEntry(generatedLine, generatedColumn)
	// An entry from an earlier line belongs to other code: the site has no place of its own.
	if (!('originalSource' in entry) || entry.generatedLine !== generatedLine) return undefined
	// The site can fall inside the entry's span: keep its offset from the entry's start. A segment
	// without a source of its own carries the previous one's in Node's parser; loop calls always
	// get a mapping of their own, so that only matters in theory.
	return {
		file: entry.originalSource,
		line: entry.originalLine + 1,
		column: entry.originalColumn + 1 + (generatedColumn - entry.generatedColumn),
	}
}

function appSourceMap(bundle: string): SourceMap | undefined {
	if (unmapped.has(bundle)) return undefined
	const failure = unreadable.get(bundle)
	if (failure !== undefined) throw failure
	if (decoded?.bundle === bundle) return decoded.map
	const payload = readAppSourceMap(bundle)
	if (payload === undefined) {
		unmapped.add(bundle)
		return undefined
	}
	const map = new SourceMap(payload)
	decoded = { bundle, map }
	setImmediate(() => {
		decoded = undefined
	}).unref()
	return map
}

/** The build's source map next to `bundle`, or `undefined` when it has none (or only another tool's). */
function readAppSourceMap(bundle: string): SourceMapPayload | undefined {
	const mapFile = `${bundle}.map`
	try {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked for the build's marker below
		const payload = JSON.parse(readFileSync(mapFile, 'utf8')) as SourceMapPayload & Record<string, unknown>
		return payload[appSourceMapMarker] === true ? payload : undefined
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return undefined
		const failure = new Error(`Couldn't read ${mapFile}, which loops are keyed through. Build the app again.`, { cause: error })
		unreadable.set(bundle, failure)
		throw failure
	}
}
