/**
 * The Atlassian connector, as workflow code uses it. Jira: functions for code (`jira.collect`,
 * `jira.comment`, `jira.transition`) and tools for agents (`jira.search`, `jira.dump`).
 * Confluence: `confluence.collect` for code, and `confluence.search` and `confluence.dump` for
 * agents. Cloud and Data Center alike. Whatever needs the token runs on the host, through the
 * gateway; the sandbox never has it.
 *
 * Every call also fails, saying what to set, when the product's site or token isn't set on the
 * host: `atlassian/url`, `atlassian/email` and `atlassian/token` for Atlassian Cloud, or
 * `<product>/url` and `<product>/token` for a product on Data Center.
 *
 * @module
 */
export * as confluence from '../confluence.mts'
export * as jira from '../jira.mts'
export { JiraIssueParameters, type IssueReference, type JiraIssue } from '../issue/issue.mts'
export type { ConfluencePage } from '../page/page.mts'
export type { PageReference } from '../page/page-reference.mts'
