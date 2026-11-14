import { stubs } from '../stubs.mts'

/**
 * Searches the GitLab projects the user of the token is a member of, by words in their name, path
 * or description: a tool for agents that have to find where a change goes, and a function for
 * code. Each comes with its path, which `gitlab.checkout` takes as its `repository`.
 *
 * ```ts
 * await planner.loop`Find the repositories ${story} touches with ${gitlab.searchRepositories}.`
 * ```
 */
export const searchRepositories = stubs.searchRepositories
