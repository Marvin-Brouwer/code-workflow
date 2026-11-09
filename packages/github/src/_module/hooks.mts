/**
 * GitHub's webhooks for `webhook` triggers: a schema per event with GitHub's signature scheme and
 * delivery header filled in, and `github.onIssueLabeled(workflow, label)` as a ready-made trigger.
 *
 * @module
 */
export * as github from '../hooks.mts'
