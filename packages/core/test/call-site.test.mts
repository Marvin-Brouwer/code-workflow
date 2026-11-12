import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { callSiteText } from '../src/run/call-site.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** Maps line 2, from column 9 on, of a bundle to line 10, column 3 of `workflows/fix.mts`. */
const sourceMap = { version: 3, sources: ['workflows/fix.mts'], names: [], mappings: ';QASE' }

describe('callSiteText', () => {
	test('names the place in the source when the bundle has a source map, so a rebuild keeps it', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const bundle = path.join(directory, 'main.mjs')
		await writeFile(bundle, 'export function at(look) {\n\treturn look()\n}\n')
		await writeFile(`${bundle}.map`, JSON.stringify(sourceMap))

		// Act
		const text = callSiteText({ file: bundle, line: 2, column: 9 })

		// Assert
		expect(text).toBe('workflows/fix.mts:10:3')
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
