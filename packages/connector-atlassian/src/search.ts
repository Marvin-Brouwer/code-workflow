import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { api } from './jira-api'

export const search = tool('jiraSearch', {
	description: 'Search Jira issues with JQL. Returns keys and summaries.',
	input: z.object({ jql: z.string() }),
	action: ({ jql }) => api.search(jql),
})
