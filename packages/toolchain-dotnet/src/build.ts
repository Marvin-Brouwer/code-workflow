import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { cli } from './cli'

export const build = tool('build', {
	description: 'Build the solution in a repository.',
	input: z.object({ repository: z.string() }),
	action: ({ repository }) => cli.build(repository),
})
