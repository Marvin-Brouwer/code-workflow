/**
 * The Atlassian connector, as workflow code uses it. Jira: functions for code (`jira.collect`,
 * `jira.comment`, `jira.transition`) and tools for agents (`jira.search`, `jira.dump`).
 * Confluence: `confluence.collect` for code, and `confluence.search` and `confluence.dump` for
 * agents. Cloud and Data Center alike. Whatever needs the token runs on the host, through the
 * gateway; the sandbox never has it.
 *
 * Every call also fails, saying what to set, when the product's site or token isn't set on the
 * host (`mesh-flow credential set jira/url`, `jira/token`, and the same for `confluence/`). On
 * Cloud, a missing `<product>/email` fails as a refused token instead: without it, the token is
 * sent as a Data Center personal access token.
 *
 * @module
 */
export * as confluence from '../confluence.mts'
export * as jira from '../jira.mts'
export { JiraIssueParameters, type IssueRef, type JiraIssue } from '../issue/issue.mts'
export type { ConfluencePage } from '../page/page.mts'
export type { PageRef } from '../page/page-ref.mts'
