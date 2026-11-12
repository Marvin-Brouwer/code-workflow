import { z } from 'zod'
import { IssueKey } from './issue-key.mts'

/** The most issues a search hands back when it isn't told. */
export const defaultSearchLimit = 20

/** The most issues one search hands back: Jira's own page size for a search. */
export const maxSearchLimit = 100

/** An issue a search found. */
export const FoundIssue = z.object({
	key: IssueKey,
	summary: z.string(),
	status: z.string(),
	type: z.string(),
	url: z.url(),
})
export type FoundIssue = z.infer<typeof FoundIssue>

/** Searches issues with JQL on the host. */
export const searchIssues = {
	name: 'jiraSearch',
	description:
		'Searches Jira issues with JQL, such as `project = PROJ AND text ~ "login"`. Returns their keys, summaries, statuses and types; read one with the dump tool.',
	input: z.object({
		jql: z.string().min(1).describe('The JQL query'),
		limit: z
			.int()
			.min(1)
			.max(maxSearchLimit)
			.optional()
			.describe(`The most issues to return. Default: ${String(defaultSearchLimit)}.`),
	}),
	output: z.object({
		issues: z.array(FoundIssue),
		more: z.boolean().describe('Whether more issues match than were returned'),
	}),
}
