import { stubs } from '../stubs.mts'

/**
 * Searches the GitLab projects the user of the token is a member of, by words in their name, path
 * or description: a tool for agents that have to find where a change goes, and a function for
 * code. Each comes with its path, which `gitlab.checkout` takes as its `repository`, its name,
 * description, URL and default branch (none for a project without commits).
 *
 * Input: `{ query, limit? }`. `query` is the words to look for; `limit` is how many projects come
 * back, 20 by default and 100 at most. The result is `{ repositories, more }`, with `more` telling
 * whether more projects match.
 *
 * @throws When GitLab turns the token down.
 *
 * @example From code
 * ```ts
 * const { repositories } = await gitlab.searchRepositories({ query: 'billing' })
 * const checkouts = await Promise.all(
 * 	repositories.map((found) => gitlab.checkout({ repository: found.repository, branch: `feature/${story.key.toLowerCase()}` })),
 * )
 * ```
 *
 * @example For an agent
 * ```ts
 * await planner.loop`Find the repositories ${story} touches with ${gitlab.searchRepositories}, then plan with ${propose(Plan)}.`
 * ```
 */
export const searchRepositories = stubs.searchRepositories
