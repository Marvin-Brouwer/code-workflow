/**
 * Jira's webhooks for `webhook` triggers: a schema per event with Jira's signature scheme and
 * delivery header filled in, and `jira.onIssueLabeled(workflow, label)` as a ready-made trigger.
 *
 * @module
 */
export * as jira from '../hooks.mts'
