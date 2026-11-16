import { describe, expect, test } from 'vitest'
import { withFrontmatter } from '../src/frontmatter.mts'

describe('withFrontmatter', () => {
	test('quotes text a YAML 1.1 reader would read as something else', () => {
		// Act
		const markdown = withFrontmatter({ created: '2026-11-10T10:00:00.000Z', answer: 'yes', title: 'Fix: login' }, '# Body')

		// Assert
		expect(markdown).toBe('---\ncreated: "2026-11-10T10:00:00.000Z"\nanswer: "yes"\ntitle: "Fix: login"\n---\n\n# Body')
	})
})
