import { readFileSync } from 'node:fs'
import { SourceMap, type SourceMapPayload } from 'node:module'
import type { CallSite } from './call-site.mts'

/** The source map next to each bundle seen so far, or `undefined` when it has none. */
const sourceMaps = new Map<string, SourceMap | undefined>()

/**
 * Where `site` is in the source, when its file is a bundle with a source map next to it
 * (`main.mjs.map`, as `mesh-flow build` writes it): the source file as the map names it, so a
 * rebuild that moves the bundle's lines keeps the site. Without a map, `undefined`.
 */
export function sourceSite(site: CallSite): CallSite | undefined {
	const origin = sourceMapOf(site.file)?.findOrigin(site.line, site.column)
	if (origin === undefined || !('fileName' in origin)) return undefined
	return { file: origin.fileName, line: origin.lineNumber, column: origin.columnNumber }
}

function sourceMapOf(file: string): SourceMap | undefined {
	if (!sourceMaps.has(file)) sourceMaps.set(file, readSourceMap(`${file}.map`))
	return sourceMaps.get(file)
}

function readSourceMap(file: string): SourceMap | undefined {
	let text: string
	try {
		text = readFileSync(file, 'utf8')
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by the build next to the bundle
	return new SourceMap(JSON.parse(text) as SourceMapPayload)
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
