/**
 * The GitLab connector, as workflow code uses it: functions for code (`gitlab.checkout`,
 * `gitlab.describe`, `gitlab.openMergeRequest`, `gitlab.updateMergeRequest`,
 * `gitlab.mergedMergeRequest`, `gitlab.review`, `gitlab.triage`, `gitlab.publishedPackages`), tools
 * for agents (`gitlab.searchRepositories`, `gitlab.push`, `gitlab.reply`) and a check for `verify`
 * (`gitlab.pipelinePasses`). Whatever needs the token runs on the host, through the gateway; the
 * sandbox never has it.
 *
 * @module
 */
export * as gitlab from '../gitlab.mts'
