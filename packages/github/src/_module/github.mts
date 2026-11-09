/**
 * The GitHub connector, as workflow code uses it: functions for code (`github.collect`,
 * `github.checkout`, `github.openPullRequest`, `github.review`), tools for agents (`github.push`,
 * `github.reply`) and a check for `verify` (`github.checksPass`). Whatever needs the token runs on
 * the host, through the gateway; the sandbox never has it.
 *
 * @module
 */
export * as github from '../github.mts'
