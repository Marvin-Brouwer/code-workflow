import { jira, type JiraIssue } from '@mesh-flow/atlassian'

/** The statuses a run moves a story through, in their order. */
const storyStatuses = ['In Progress', 'In Review', 'Done'] as const
/** A status the run moves a story to. */
export type StoryStatus = (typeof storyStatuses)[number]

/**
 * Moves a story on to `status`, and never back. A run that starts over from the top, and a story
 * that GitLab's Jira integration moved to Done when a merge request closed it, are further along
 * already; most Jira workflows have no way back, and the story shouldn't take one.
 */
export async function moveOn(story: JiraIssue, status: StoryStatus): Promise<void> {
	// A search reads the status alone, and leaves the story's file in the workspace as it is.
	const { issues } = await jira.search({ jql: `key = ${story.key}`, limit: 1 })
	const now = issues[0]?.status
	if (now === undefined) throw new Error(`Jira finds no story ${story.key}.`)
	// Jira matches status names without regard to case, as `jira.transition` does.
	const reached = storyStatuses.findIndex((known) => known.toLowerCase() === now.toLowerCase())
	if (reached >= storyStatuses.indexOf(status)) return
	await jira.transition(story, status)
}
