import { changeTextSchema, type ChangeContent } from '@mesh-flow/forge'
import type { z } from 'zod'

/** The longest title GitLab takes. */
const maxTitleCharacters = 255

/** The longest description GitLab takes: a mebibyte's worth of characters. */
const gitlabDescriptionCharacters = 1_048_576

/** Room left in the description for the footer the connector adds: the signature and what it closes. */
const footerRoom = 48_576

/**
 * What a merge request says: its title and its description, as the agent of `describe` writes them,
 * within GitLab's limits, less the room for the footer.
 */
export const MergeRequestText = changeTextSchema({
	maxTitleCharacters,
	maxDescriptionCharacters: gitlabDescriptionCharacters - footerRoom,
	request: 'merge request',
})
export type MergeRequestText = z.infer<typeof MergeRequestText>

/**
 * What a merge request closes when it merges, by its key: a Jira issue, such as one
 * `@mesh-flow/atlassian` collected, with GitLab's Jira integration on. In a prompt it renders as
 * the value does, so the agent of `describe` can read it.
 */
export interface ClosesIssue {
	readonly key: string
}

/**
 * What a merge request is opened or updated with: its text, the commit the text was written for and
 * the issue it closes, for which `Fixes` goes in the footer. `describe` resolves to one, ready for
 * `openMergeRequest` or `updateMergeRequest`.
 */
export type MergeRequestContent = ChangeContent<ClosesIssue>

/** The `closes` field of a host call for `issue`, when there is one. */
export function closingField(issue: ClosesIssue | undefined): { closes?: string } {
	return issue === undefined ? {} : { closes: issue.key }
}
