/**
 * The smallest workflow that runs end to end: one issue, one repository, no separate plan or code
 * review. Pick up the issue, fix it, open a pull request, handle review comments until it's merged.
 * The pull request's text is written in a loop of its own, and written again when a round of review
 * or a check fix changed the code.
 * Plain async TypeScript: every `await` is real, and the agent is a call inside it.
 */
import { limit, succeed, workflow } from '@mesh-flow/core'
import { github, IssueParameters } from '@mesh-flow/github'
import { developer, writer } from '../agents.mts'

export const fixIssue = workflow('fix-issue', IssueParameters, async ({ parameters }) => {
	const issue = await github.collect(parameters.issue)
	await github.comment(issue, 'Picking this up. A pull request follows.', { key: 'status' })
	const repository = await github.checkout({ repository: issue.repository, branch: `fix/${String(issue.number)}` })

	await developer.loop`
		Fix ${issue} in ${repository}. Push your changes with ${github.push(repository)}, then ${succeed()}.
		${limit({ minutes: 30 })}
	`

	const text = await github.describe(writer, repository, { issue })
	const pullRequest = await github.openPullRequest(repository, { ...text, closes: issue })
	// After a round that may have changed the code; no loop runs when it didn't.
	const describeAgain = async () =>
		github.updatePullRequest(pullRequest, { ...(await github.describe(writer, repository, { issue, pullRequest })), closes: issue })
	await github.comment(issue, `Pull request opened: ${pullRequest.url}`, { key: 'status' })

	// Returns once the pull request is merged or closed. Each round of review comments is one loop.
	const outcome = await github.review(pullRequest, {
		comments: async (comments) => {
			await developer.loop`
				Handle these review comments on ${pullRequest}: ${comments}.
				Change the code in ${repository} where a comment asks for it, push with ${github.push(repository)},
				and reply to every comment with ${github.reply(pullRequest)}.
				When every comment is handled, ${succeed()}.
				${limit({ minutes: 30 })}
			`
			await describeAgain()
		},
		checksFailed: async (failed) => {
			await developer.loop`
				The checks on ${pullRequest} failed: ${failed.failures}.
				Fix the cause in ${repository}, push with ${github.push(repository)}, then ${succeed()}.
				${limit({ minutes: 20 })}
			`
			await describeAgain()
		},
	})

	if (outcome.state === 'merged') await github.close(issue)
})
