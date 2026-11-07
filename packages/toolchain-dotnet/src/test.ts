import { check, tool } from '@mesh-flow/core'
import { type Repository } from '@mesh-flow/git'
import { z } from 'zod'
import { cli } from './cli'

/** For the developer: run the tests while working. */
export const test = tool('test', {
	description: 'Run tests in a repository, optionally filtered.',
	input: z.object({ repository: z.string(), filter: z.string().optional() }),
	action: ({ repository, filter }) => cli.test(repository, filter),
})

/** For `verify`: the full test run that has to pass before the developer may finish. */
export function tests(repository: Repository) {
	return check('tests', async () => {
		const result = await cli.test(repository)
		return result.failures.map((message) => ({ source: 'tests', message }))
	})
}
