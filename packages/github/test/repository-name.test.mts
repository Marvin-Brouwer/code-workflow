import { describe, expect, test } from 'vitest'
import { RepositoryName } from '../src/repository-name.mts'

describe('RepositoryName', () => {
	test.each(['team/app', 'my-org/my.app_2', 'a/b'])('takes %s', (name) => {
		// Act
		const parsed = RepositoryName.safeParse(name)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test.each(['../..', '../app', 'team/..', 'team/.', 'app', 'team/app/extra', '-team/app', 'team/app name', ''])(
		'refuses %s, which is not owner/name or would leave the owner directory',
		(name) => {
			// Act
			const parsed = RepositoryName.safeParse(name)

			// Assert
			expect(parsed.success).toBe(false)
		},
	)
})
