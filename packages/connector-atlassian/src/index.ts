/**
 * Jira connector: plain functions for code, tools for agents.
 * A story interpolated in a prompt renders as the path of its Markdown dump in the workspace.
 */
import { tool } from '@engine/core';
import { z } from 'zod';
import { api, type Story } from './jira-api';

export const key = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('Jira key, e.g. PROJ-123');

// ─── Functions ───────────────────────────────────────────────────────────────────────────────

/** Dumps a story, its comments and linked issues to Markdown in the workspace. */
export function collect(storyKey: string): Promise<Story> {
    return api.dump(storyKey);
}

/** Moves a story to another status. Does nothing when it already has that status. */
export function transition(story: Story, status: 'In Progress' | 'In Review' | 'Done'): Promise<void> {
    return api.transition(story, status);
}

/** Adds a comment. Skips it when the story already has a comment with the same text. */
export function comment(story: Story, text: string): Promise<void> {
    return api.comment(story, text, { deduplicate: true });
}

// ─── Tools ───────────────────────────────────────────────────────────────────────────────────

export const search = tool('jiraSearch', {
    description: 'Search Jira issues with JQL. Returns keys and summaries.',
    input: z.object({ jql: z.string() }),
    action: ({ jql }) => api.search(jql),
});

export const dump = tool('jiraDump', {
    description: 'Dump an issue to Markdown in the workspace and return its path.',
    input: z.object({ key }),
    action: ({ key }) => api.dumpMarkdown(key),
});
