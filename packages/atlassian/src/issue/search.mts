import { stubs } from '../stubs.mts'

/**
 * Searches Jira with JQL: a tool for agents, and a function for code. Returns keys, summaries,
 * statuses and types, and whether more issues match; `jira.dump` reads one.
 *
 * ```ts
 * const related = await jira.search({ jql: `text ~ "${story.summary}"` })
 * await planner.loop`Research ${story}. Find related issues with ${jira.search} and read them with ${jira.dump}.`
 * ```
 */
export const search = stubs.searchIssues
