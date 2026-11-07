/**
 * GitLab connector: plain functions for code, tools for agents, checks for `verify`.
 * Every function is idempotent where it creates something (reuses an existing checkout, branch
 * or merge request), so a rerun after a lost snapshot is cheap.
 */
export * as gitlab from './gitlab.mts'
