import { jira, type IssueRef } from '@mesh-flow/atlassian'

/** The statuses a run moves a story through, in their order. */
const storyStatuses = ['In Progress', 'In Review', 'Done'] as const
export type StoryStatus = (typeof storyStatuses)[number]

/**
 * Moves a story on to `status`, and never back. A run that starts over from the top, and a story
 * that GitLab's Jira integration moved to Done when a merge request closed it, are further along
 * already; most Jira workflows have no way back, and the story shouldn't take one.
 */
export async function moveOn(story: IssueRef, status: StoryStatus): Promise<void> {
	const { status: now } = await jira.collect(story)
	if (storyStatuses.findIndex((known) => known === now) >= storyStatuses.indexOf(status)) return
	await jira.transition(story, status)
}
