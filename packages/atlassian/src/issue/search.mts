import { stubs } from '../stubs.mts'

/**
 * Searches Jira with JQL: a tool for agents, and a function for code. Returns each issue's key,
 * summary, status, type and URL, and whether more issues match than came back; `jira.dump` and
 * `jira.collect` read one in full.
 *
 * Input: `{ jql, limit? }`. `jql` is any JQL query Jira takes, such as
 * `project = PROJ AND labels = web`; `limit` is how many issues come back at most, 20 when not
 * given and 100 at most. Results come in Jira's order, so put an `ORDER BY` in the query when the order matters.
 *
 * @throws When Jira turns the query down, such as for a field it doesn't know.
 *
 * @example From code
 * ```ts
 * const limit = 50
 * const { issues, more } = await jira.search({ jql: `parent = ${story.key} AND statusCategory != Done`, limit })
 * for (const subtask of issues) await jira.transition(subtask, 'In Progress')
 * if (more) await jira.comment(story, `More than ${String(limit)} open subtasks: the rest wait for the next run.`, { key: 'subtasks' })
 * ```
 *
 * @example For an agent
 * ```ts
 * await researcher.loop`Research ${story}. Find related issues with ${jira.search} and read them with ${jira.dump}.`
 * ```
 */
export const search = stubs.searchIssues
