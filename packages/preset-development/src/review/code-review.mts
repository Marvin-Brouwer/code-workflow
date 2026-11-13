import { check, succeed, type Agent, type Check, type RendersInPrompt } from '@mesh-flow/core'
import { z } from 'zod'
import { deviations } from '../deviations/deviations.mts'
import type { Plan } from '../plan/plan.mts'

/** A checkout to review, such as `gitlab.checkout` or `github.checkout` gives: it renders as where it is on disk. */
export interface ReviewedCheckout extends RendersInPrompt {
	readonly name: string
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
 * its own each time the work is handed in, so a fixed finding isn't reported again.
 *
 * ```ts
 * await developer.loop`
 * 	Implement ${plan.path} in ${repository}, then hand in with ${verify(dotnet.tests(repository), codeReview(reviewer, repository, plan))}.
 * `
 * ```
 */
export function codeReview(reviewer: Agent, repository: ReviewedCheckout, plan: Plan): Check {
	return check('code review', async () => {
		const { findings } = await reviewer.loop`
			Review the changes in ${repository}: what \`git diff origin/${repository.defaultBranch}\` shows there, committed or not.
			Review them against ${plan.path}, and the deviations recorded in ${deviations} when that file exists.
			Report only real problems: bugs, missing tests, and deviations from the plan that weren't recorded. Change no file.
			When you're done, ${succeed(Findings)}, with no findings when the changes are good.
		`
		return findings.map((finding) => ({ source: `code review: ${finding.where}`, message: finding.message }))
	})
}
