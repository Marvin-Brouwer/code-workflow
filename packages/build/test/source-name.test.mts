import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { sourceName } from '../src/source-name.mts'

const root = path.resolve('repository')

describe('sourceName', () => {
	test('names a file of the repository relative to it, with /', () => {
		// Act
		const name = sourceName(root, path.join(root, 'workflows', 'fix-issue.mts'))

		// Assert
		expect(name).toBe('workflows/fix-issue.mts')
	})

	test("names a package in pnpm's store from its package name on, so its peers' versions don't count", () => {
		// Arrange
		const file = path.join(
			root,
			'node_modules',
			'.pnpm',
			'@mesh-flow+github@1.0.0_zod@4.6.7',
			'node_modules',
			'@mesh-flow',
			'github',
			'dist',
			'github.mjs',
		)

		// Act
		const name = sourceName(root, file)

		// Assert
		expect(name).toBe('@mesh-flow/github/dist/github.mjs')
	})

	test('keeps the package a nested package is installed in', () => {
		// Arrange
		const file = path.join(root, 'node_modules', 'a', 'node_modules', 'b', 'index.js')

		// Act
		const name = sourceName(root, file)

		// Assert
		expect(name).toBe('a/node_modules/b/index.js')
	})

	test('only takes a whole node_modules folder for installed packages', () => {
		// Act
		const name = sourceName(root, path.join(root, 'my_node_modules', 'x.mts'))

		// Assert
		expect(name).toBe('my_node_modules/x.mts')
	})
})
