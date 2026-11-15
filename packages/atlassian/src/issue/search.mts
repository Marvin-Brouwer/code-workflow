import { stubs } from '../stubs.mts'

/**
 * Searches Jira with JQL: a tool for agents, and a function for code. Returns each issue's key,
 * summary, status, type and URL, and whether more issues match than came back; `jira.dump` and
 * `jira.collect` read one in full.
 *
 * Input: `{ jql, limit? }`. `jql` is any JQL query Jira takes, such as
 * `project = PROJ AND labels = web`; `limit` is how many issues come back at most, 20 when not
 * given. Results come in Jira's order, so put an `ORDER BY` in the query when the order matters.
 *
 * Throws when Jira turns the query down, such as for a field it doesn't know.
 *
 * @example From code
 * ```ts
 * const { issues, more } = await jira.search({ jql: `parent = ${story.key} AND statusCategory != Done`, limit: 50 })
 * for (const subtask of issues) await jira.transition(subtask, 'In Progress')
 * if (more) console.log(`More than 50 open subtasks of ${story.key}; the rest wait for the next run.`)
 * ```
 *
 * @example For an agent
 * ```ts
 * await researcher.loop`Research ${story}. Find related issues with ${jira.search} and read them with ${jira.dump}.`
 * ```
 */
export const search = stubs.searchIssues
