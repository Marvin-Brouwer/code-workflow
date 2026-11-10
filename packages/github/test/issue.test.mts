import { describe, expect, test } from 'vitest'
import { markdownOf } from '../src/issue/issue.mts'

const data = {
	repository: 'team/app',
	number: 7,
	title: 'Login fails on Safari',
	body: '  Steps: open the login page.  ',
	state: 'open' as const,
	labels: ['bug', 'ai-fix'],
	author: 'reporter',
	url: 'https://github.com/team/app/issues/7',
	createdAt: '2026-11-09T10:00:00Z',
}

describe('markdownOf', () => {
	test('writes the issue as a heading, its facts and its body', () => {
		// Act
		const markdown = markdownOf(data)

		// Assert
		expect(markdown).toBe(
			[
				'# #7: Login fails on Safari',
				'',
				'- Repository: team/app',
				'- URL: https://github.com/team/app/issues/7',
				'- Author: reporter',
				'- State: open',
				'- Labels: bug, ai-fix',
				'- Created: 2026-11-09T10:00:00Z',
				'',
				'Steps: open the login page.',
				'',
			].join('\n'),
		)
	})

	test('writes none and (no description) for an issue without labels or body', () => {
		// Act
		const bare = markdownOf({ ...data, body: '', labels: [] })

		// Assert
		expect(bare).toContain('- Labels: none')
		expect(bare).toContain('\n\n(no description)\n')
	})
})
