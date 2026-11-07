import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { api, type Story } from './jira-api'
import { key } from './key'

/** Dumps a story, its comments and linked issues to Markdown in the workspace. */
export function collect(storyKey: string): Promise<Story> {
	return api.dump(storyKey)
}

/** Moves a story to another status. Does nothing when it already has that status. */
export function transition(story: Story, status: 'In Progress' | 'In Review' | 'Done'): Promise<void> {
	return api.transition(story, status)
}

/** Adds a comment. Skips it when the story already has a comment with the same text. */
export function comment(story: Story, text: string): Promise<void> {
	return api.comment(story, text, { deduplicate: true })
}

/** The tool form of `collect`, for agents: dumps an issue and returns the path of the dump. */
export const dump = tool('jiraDump', {
	description: 'Dump an issue to Markdown in the workspace and return its path.',
	input: z.object({ key }),
	action: ({ key }) => api.dumpMarkdown(key),
})
