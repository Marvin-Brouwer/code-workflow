import { z } from 'zod'

/**
 * A Jira issue key, such as `PROJ-123`: the project's key, uppercase letters, digits and `_`
 * starting with a letter, then the issue's number.
 */
export const IssueKey = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]+-[1-9]\d*$/, 'Use a Jira issue key, such as PROJ-123.')
	.describe('A Jira issue key, such as PROJ-123')
export type IssueKey = z.infer<typeof IssueKey>
