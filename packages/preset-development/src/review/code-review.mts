import { check, succeed, untilAborted, type Agent, type Check, type RendersInPrompt } from '@mesh-flow/core'
import { z } from 'zod'
import { deviations } from '../deviations/deviations.mts'
import type { Plan } from '../plan/plan.mts'
import { treeState } from './tree-state.mts'

/** A checkout to review, such as `gitlab.checkout` or `github.checkout` gives: it renders as where it is on disk. */
export interface ReviewedCheckout extends RendersInPrompt {
	/** The repository as the code host names it. */
	readonly name: string
	/** The checkout on disk. */
	readonly directory: string
	/** The branch the changes go onto, which `origin/<defaultBranch>` tracks in the checkout. */
	readonly defaultBranch: string
}

/** What the reviewer hands in: each real problem, with where it is. */
const Findings = z.object({
	findings: z.array(
		z.object({
			where: z.string().min(1).describe('The file and line, or the part of the change, it is about'),
			message: z.string().min(1).describe('The problem, and what fixing it takes'),
		}),
	),
})

/**
 * A check for `verify` that has `reviewer` review the changes in `repository` against the plan and
 * its recorded deviations, and reports each real problem it finds as a finding. It runs a loop of
 * its own for each state of the checkout it is handed in with, so a fixed finding isn't reported
 * again, and a rerun never takes the review of other changes for this one. The reviewer's loop
 * stops with the run, or with the loop that verifies.
 *
 * @param reviewer - The workflow's own agent, since the package ships none. It is told to change no
 * file and only to report.
 * @param repository - The checkout to review, such as `gitlab.checkout` or `github.checkout` gives.
 * @param plan - The plan the changes carry out.
 * @returns The check, for `verify` in an agent's template, or for `runCheck` in code. No findings
 * means the reviewer found no real problem.
 * @throws From the check: when git can't read the checkout's state; when the reviewer's loop fails
 * or runs out of its limit; and, with the stop's reason, when the run stops or the check's signal
 * aborts.
 *
 * @example From code, before a merge request is opened
 * ```ts
 * const findings = await runCheck(codeReview(reviewer, repository, plan), { abortSignal })
 * const list = findings.map((finding) => finding.message).join('\n')
 * if (findings.length > 0) await developer.loop`Fix these in ${repository}, then ${succeed()}:\n${list}`
 * ```
 *
 * @example Next to the tests, for the agent that makes the change
 * ```ts
 * await developer.loop`
 * 	Implement ${plan.path} in ${repository}, then hand in with ${verify(
 * 		dotnet.testsPass(repository),
 * 		codeReview(reviewer, repository, plan),
 * 	)}.
 * `
 * ```
 */
export function codeReview(reviewer: Agent, repository: ReviewedCheckout, plan: Plan): Check {
	return check('code review', async ({ abortSignal }) => {
		// The state and the merge base are in the prompt, so a rerun never takes a review of other changes,
		// and commits on the default branch since don't read as reverted.
		const { fingerprint: state, base } = await treeState(repository.directory, repository.defaultBranch, {
			abortSignal,
			files: [deviations.location()],
		})
		const review = reviewer.loop`
			Review the changes in ${repository}, as they are now (state ${state}): what \`git diff ${base}\` shows there,
			committed or not, and the new files \`git status\` lists as untracked.
			Review them against ${plan.path}, and the deviations recorded in ${deviations} when that file exists.
			Report only real problems: bugs, missing tests, and deviations from the plan that weren't recorded. Change no file.
			When you're done, ${succeed(Findings)}, with no findings when the changes are good.
		`
		// The loop stops with the run, or with the loop that verifies; the check settles when its own signal aborts.
		const { findings } = await untilAborted(review, abortSignal)
		return findings.map((finding) => ({ source: `code review: ${finding.where}`, message: finding.message }))
	})
}
