/**
 * The `example` development workflow: a Jira story from research to merged merge requests, one per
 * repository the plan changes. Plain async TypeScript: every `await` is real, and agents are calls
 * inside it. While the run waits for a person or for GitLab, the sandbox can be paused; the answer
 * resumes it and the await resolves in the same stack.
 */
import { fail, inDependencyOrder, limit, propose, succeed, verify, workflow } from '@mesh-flow/core'
import { confluence, jira, JiraIssueParameters } from '@mesh-flow/atlassian'
import { gitlab } from '@mesh-flow/gitlab'
import { codeReview, deliveryOrder, deviations, Plan, planFile, Research } from '@mesh-flow/preset-development'
import { dotnet } from '@mesh-flow/toolchain-dotnet'
import { developer, planner, reviewer, writer } from '../agents.mts'

export const develop = workflow('develop', JiraIssueParameters, async ({ parameters }) => {
	const story = await jira.collect(parameters.key)
	await jira.transition(story, 'In Progress')

	const research = await planner.loop`
		Do preliminary research for ${story}.
		Find related issues with ${jira.search} and read them with ${jira.dump}.
		Look for the team's guidelines with ${confluence.search} and read them with ${confluence.dump}.
		Find the repositories each part of the work touches with ${gitlab.searchRepositories}.
		Write your findings as Markdown in ${Research}, then ${succeed(Research)}.
	`

	const plan = await planner.loop`
		Create a development plan for ${story}, based on ${research}.
		List every repository that needs changes, by its project path. When a repository needs something
		from another one first, such as a new package version or an API contract, add it to the
		dependency graph with the reason; repositories are delivered in that order.
		Write the plan to ${planFile}, then propose it with ${propose(Plan)}.
		When the proposal is rejected, revise the plan with the feedback and propose it again.
		If the story can't be planned with the information available, ${fail}.
	`
	await jira.comment(story, `The plan is approved, for ${plan.repositories.map(({ name }) => name).join(', ')}.`, { key: 'progress' })

	// Starts each repository once the repositories it depends on are merged, with the packages
	// their merges published. Independent repositories don't wait for each other.
	await inDependencyOrder(deliveryOrder(plan), async (part, upstream: readonly (readonly gitlab.PublishedPackage[])[]) => {
		const repository = await gitlab.checkout(part.repository, { branch: `feature/${story.key}` })
		await dotnet.updatePackages(repository, upstream.flat())

		await developer.loop`
			Implement your part of ${plan.path}, as amended by ${deviations}, in ${repository}: ${part.changes}
			Build with ${dotnet.build} and test with ${dotnet.test} until both pass, then hand in your work with ${verify(
				dotnet.tests(repository),
				dotnet.security(repository),
				codeReview(reviewer, repository, plan),
			)}.
			When it's rejected, fix the findings and hand it in again.
			Record any deviation from the plan with ${deviations.record}.
			${limit({ minutes: 120 })}
		`

		const mergeRequest = await gitlab.openMergeRequest(repository, await gitlab.describe(writer, repository, { closes: story }))
		// A merge request closed meanwhile is given back as it is, not opened again.
		if (mergeRequest.state === 'closed') throw new Error(`${mergeRequest.url} was closed, so ${part.repository} isn't delivered.`)
		await jira.transition(story, 'In Review')
		await jira.comment(story, `Merge request for ${repository.name}: ${mergeRequest.url}`, { key: `merge-request ${repository.name}` })

		// Returns once the merge request is merged or closed. Each round of review comments is one call.
		const outcome = await gitlab.review(mergeRequest, {
			async comments(comments) {
				// Questions are answered here; what asks for a change gets a plan as its reply, and comes back.
				const changes = await gitlab.triage(reviewer, repository, { mergeRequest, comments })
				if (changes.length === 0) return
				await developer.loop`
					Make these changes in ${repository}, as they were planned: ${changes}.
					When a change goes beyond this merge request, record it with ${deviations.record}.
					Push with ${gitlab.push(repository)}, then reply to every item with what you did, using ${gitlab.reply(mergeRequest)}.
					When every item is done, hand in with ${verify(dotnet.tests(repository))}.
					${limit({ minutes: 45 })}
				`
				// `describe` runs no writer loop when the pushed commit is already described.
				await gitlab.updateMergeRequest(mergeRequest, await gitlab.describe(writer, repository, { closes: story, mergeRequest }))
			},
			async pipelineFailed({ failures }) {
				await developer.loop`
					The pipeline of ${mergeRequest} failed: ${failures}.
					Fix the cause in ${repository}, push with ${gitlab.push(repository)}, then hand in with ${verify(gitlab.pipelinePasses(mergeRequest))}.
					${limit({ minutes: 45 })}
				`
				await gitlab.updateMergeRequest(mergeRequest, await gitlab.describe(writer, repository, { closes: story, mergeRequest }))
			},
		})
		if (outcome.state === 'closed') throw new Error(`${mergeRequest.url} was closed without a merge.`)

		// Only what another repository waits for: a project that publishes nothing has no packages to wait for.
		return part.hasDependents ? gitlab.publishedPackages(mergeRequest, 'nuget') : []
	})

	await jira.transition(story, 'Done')
	await jira.comment(story, 'Every merge request is merged.', { key: 'progress' })
})
