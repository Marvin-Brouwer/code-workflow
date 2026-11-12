/**
 * The smallest workflow that runs end to end: one issue, one repository, no separate plan or code
 * review. Pick up the issue, fix it, open a pull request, handle review comments until it's merged.
 * The pull request's text is written in a loop of its own, and written again when a round of review
 * or a check fix changed the code. Each round of review is sorted first: questions are answered
 * right away, and what asks for a change gets a plan as its reply before the work is done.
 * Plain async TypeScript: every `await` is real, and the agent is a call inside it.
 */
import { limit, succeed, workflow } from '@mesh-flow/core'
import { github, IssueParameters } from '@mesh-flow/github'
import { developer, writer } from '../agents.mts'
import { installDependencies } from './install-dependencies.mts'

export const fixIssue = workflow('fix-issue', IssueParameters, async ({ parameters, abortSignal }) => {
	const issue = await github.collect(parameters.issue)
	await github.comment(issue, 'Picking this up. A pull request follows.', { key: 'status' })
	const repository = await github.checkout({ repository: issue.repository, branch: `fix/${String(issue.number)}` })

	const installed = await installDependencies(repository, abortSignal)
	const installNote = installed.state === 'failed' ? `Installing its npm dependencies failed:\n${installed.output}\n` : ''

	await developer.loop`
		${installNote}Fix ${issue} in ${repository}. Push your changes with ${github.push(repository)}, then ${succeed()}.
		${limit({ minutes: 30 })}
	`

	const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
	// A pull request closed meanwhile is given back as it is, not opened again.
	if (pullRequest.state === 'closed') {
		await github.comment(issue, `Stopped: ${pullRequest.url} was closed.`, { key: 'status' })
		return
	}
	await github.comment(issue, `Pull request opened: ${pullRequest.url}`, { key: 'status' })

	// Returns once the pull request is merged or closed. Each round of review comments is one loop.
	const outcome = await github.review(pullRequest, {
		async comments(comments) {
			// Questions are answered here; what asks for a change gets a plan as its reply, and comes back.
			const changes = await github.triage(developer, repository, { pullRequest, comments })
			if (changes.length === 0) return
			await developer.loop`
				Make these changes in ${repository}, as you planned them: ${changes}.
				Push with ${github.push(repository)}, then reply to every item with what you did, using ${github.reply(pullRequest)}.
				When every item is done, ${succeed()}.
				${limit({ minutes: 30 })}
			`
			// `describe` runs no writer loop when the pushed commit is already described.
			await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
		},
		async checksFailed(failed) {
			await developer.loop`
				The checks on ${pullRequest} failed: ${failed.failures}.
				Fix the cause in ${repository}, push with ${github.push(repository)}, then ${succeed()}.
				${limit({ minutes: 20 })}
			`
			// `describe` runs no writer loop when the pushed commit is already described.
			await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
		},
	})

	if (outcome.state === 'merged') await github.close(issue)
})
