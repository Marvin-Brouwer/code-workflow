import { changeTextSchema, type ChangeContent } from '@mesh-flow/forge'
import type { z } from 'zod'
import type { IssueRef } from '../issue/issue.mts'

export { normalizedBody, sameText, textInPrompt, type BasedOn } from '@mesh-flow/forge'

/**
 * What a pull request says: its title and its description, as the agent of `describe` writes them,
 * within GitHub's limits: a title of 256 characters, and a body of 60 000 less room for the footer
 * the connector adds.
 */
export const PullRequestText = changeTextSchema({ maxTitleCharacters: 256, maxDescriptionCharacters: 60_000, request: 'pull request' })
export type PullRequestText = z.infer<typeof PullRequestText>

/**
 * What a pull request is opened or updated with: its text, the commit the text was written for and
 * the issue it closes, for which `Fixes` goes in the footer. `describe` resolves to one, ready for
 * `openPullRequest` or `updatePullRequest`.
 */
export type PullRequestContent = ChangeContent<IssueRef>
