import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appSourceMapMarker } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { callSiteText } from '../src/run/call-site.mts'
import { toPosix } from '../src/run/to-posix.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** Maps line 2 of a bundle, from column 9 on, to line 10, column 3 of `workflows/fix.mts`. */
const mappings = ';QASE'

const appSourceMap = { version: 3, sources: ['workflows/fix.mts'], names: [], mappings, [appSourceMapMarker]: true }

/** A bundle in a fresh folder with `map` next to it, if one is given. */
async function bundleWith(map?: string): Promise<string> {
	const bundle = path.join(await temporaryDirectory(), 'main.mjs')
	await writeFile(bundle, 'export function at(look) {\n\treturn look()\n}\n')
	if (map !== undefined) await writeFile(`${bundle}.map`, map)
	return bundle
}

describe('callSiteText', () => {
	test("names the place in the source when the bundle has the build's source map, so a rebuild keeps it", async () => {
		// Arrange
		const bundle = await bundleWith(JSON.stringify(appSourceMap))

		// Act
		const text = callSiteText({ file: bundle, line: 2, column: 9 })

		// Assert
		expect(text).toBe('workflows/fix.mts:10:3')
	})

	test('names the bundle when the map has nothing on its line, rather than borrowing an earlier line', async () => {
		// Arrange
		const bundle = await bundleWith(JSON.stringify(appSourceMap))

		// Act
		const text = callSiteText({ file: bundle, line: 3, column: 1 })

		// Assert
		expect(text).toBe(`${toPosix(path.relative(process.cwd(), bundle))}:3:1`)
	})

	test("leaves a source map alone that the build didn't write, such as a package's own", async () => {
		// Arrange
		const { [appSourceMapMarker]: _marker, ...packageSourceMap } = appSourceMap
		const bundle = await bundleWith(JSON.stringify(packageSourceMap))

		// Act
		const text = callSiteText({ file: bundle, line: 2, column: 9 })

		// Assert
		expect(text).toBe(`${toPosix(path.relative(process.cwd(), bundle))}:2:9`)
	})

	test('names the map when it cannot be read, every time it is asked', async () => {
		// Arrange
		const bundle = await bundleWith('{"version":3,')

		// Act
		const first = () => callSiteText({ file: bundle, line: 2, column: 9 })
		const again = () => callSiteText({ file: bundle, line: 2, column: 10 })

		// Assert
		expect(first).toThrow(`Couldn't read ${bundle}.map`)
		expect(again).toThrow(`Couldn't read ${bundle}.map`)
	})

	test('names the file relative to the working directory when there is no source map', () => {
		// Arrange
		const file = path.join(process.cwd(), 'workflows', 'fix.mts')

		// Act
		const text = callSiteText({ file, line: 4, column: 2 })

		// Assert
		expect(text).toBe('workflows/fix.mts:4:2')
	})
})
