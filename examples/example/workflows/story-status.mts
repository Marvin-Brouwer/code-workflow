/**
 * How the `example` workflow moves a story along on the team's board, as a run gets further.
 */
import { jira, type JiraIssue } from '@mesh-flow/atlassian'

/** The statuses a run moves a story through, in their order. */
const storyStatuses = ['In Progress', 'In Review', 'Done'] as const
/** Whether two status names are the same: Jira matches them without regard to case, as `jira.transition` does. */
function sameStatus(one: string, other: string): boolean {
	return one.toLowerCase() === other.toLowerCase()
}

/** Whether Jira counts the story's status as one of work to do, not yet started. */
async function isToDo(story: JiraIssue): Promise<boolean> {
	const { issues } = await jira.search({ jql: `key = ${story.key} AND statusCategory = "To Do"`, limit: 1 })
	return issues.length > 0
}

/** A status the run moves a story to. */
export type StoryStatus = (typeof storyStatuses)[number]

/**
 * Moves a story on to `status`, and never back. A run that starts over from the top, and a story
 * that GitLab's Jira integration moved to Done when a merge request closed it, are further along
 * already; most Jira workflows have no way back, and the story shouldn't take one. A status of the
 * team's own counts as not started when Jira puts it in its To Do category, such as Backlog, and as
 * further along otherwise, such as QA, or Closed when that is the done status the integration moved
 * the story to: that story is left where it is.
 */
export async function moveOn(story: JiraIssue, status: StoryStatus): Promise<void> {
	// A search reads the status alone, and leaves the story's file in the workspace as it is.
	const { issues } = await jira.search({ jql: `key = ${story.key}`, limit: 1 })
	const currentStatus = issues[0]?.status
	if (currentStatus === undefined) throw new Error(`Jira finds no story ${story.key}.`)
	const reached = storyStatuses.findIndex((known) => sameStatus(known, currentStatus))
	const behind = reached === -1 ? await isToDo(story) : reached < storyStatuses.indexOf(status)
	if (behind) await jira.transition(story, status)
}
