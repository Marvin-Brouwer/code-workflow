# `@mesh-flow/preset-development`

A development preset for mesh-flow: what a workflow that takes a story from research to merged changes needs besides its connectors. It has the shapes of research and of a plan, the order a plan's repositories are delivered in, a code review check for `verify`, and the plan's deviations. It ships no agents: the workflow passes its own, and the preset owns only the task instructions.

## Usage

```ts
// workflows/develop.mts
import { jira, JiraIssueParameters } from '@mesh-flow/atlassian'
import { inDependencyOrder, propose, succeed, verify, workflow } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab'
import { codeReview, deliveryOrder, deviations, Plan, planFile, Research } from '@mesh-flow/preset-development'
import { dotnet } from '@mesh-flow/toolchain-dotnet'
import { developer, planner, reviewer } from '../agents.mts'

export const develop = workflow('develop', JiraIssueParameters, async ({ parameters }) => {
	const story = await jira.collect(parameters.key)

	const research = await planner.loop`Research ${story}. Write your notes in ${Research}, then ${succeed(Research)}.`
	const plan = await planner.loop`
		Plan ${story}, based on ${research}. Write the plan to ${planFile}, then propose it with ${propose(Plan)}.
	`

	await inDependencyOrder(deliveryOrder(plan), async (part) => {
		const repository = await gitlab.checkout({ repository: part.repository, branch: `feature/${story.key}` })
		await developer.loop`
			Implement your part of ${plan.path}, as amended by ${deviations}, in ${repository}.
			Record any deviation from the plan with ${deviations.record}.
			Hand in with ${verify(dotnet.testsPass(repository), codeReview(reviewer, repository, plan))}.
		`
	})
})
```

### Research and the plan

- `Research` is a workspace folder, `research/`, for the research notes. `succeed(Research)` takes it once it holds a file, and in a later prompt it renders as the folder with its files.
- `planFile` is `plan.md` in the workspace; in a prompt it renders as its absolute path.
- `Plan` is what code needs from the plan, for `propose(Plan)`: its absolute `path`, the `repositories` it changes, each by its `repository`, its name on the code host, with a summary of its changes, and the `dependencies` between them: a repository that builds against packages another one publishes depends on it, with the reason. Names are compared in lower case, as code hosts compare them. A dependency on a repository the plan doesn't list is refused, so the agent corrects it before the plan is proposed.

### Delivery order

`deliveryOrder(plan)` gives the plan's repositories as nodes for `inDependencyOrder`, one each, in the plan's order: `{ id, repository, changes, dependsOn, hasDependents }`. `hasDependents` says whether another repository waits for this one, so the workflow only waits for what a merge publishes when someone needs it.

### Code review

`codeReview(reviewer, repository, plan)` is a check for `verify`: the reviewer reviews what the checkout changes against where its branch left the default branch, committed or not, and its untracked files, against the plan and its deviations, and each real problem it reports is a finding, `code review: <where>`. It takes any checkout that renders as its directory and has `name`, `directory` and `defaultBranch`, such as `gitlab.checkout` and `github.checkout` give. Each state of the checkout gets a review of its own, so a rerun never takes the review of other changes for this one.

### Deviations

The approved plan stays as it was approved; what turns out different later is recorded next to it, in `plan-deviations.md` in the workspace. `deviations` renders as that file in a prompt, and `deviations.record` is the tool that adds one, `{ repository, reason, change }`, in Markdown. It's a function for code too:

```ts
import { deviations } from '@mesh-flow/preset-development'

await deviations.record({ repository: 'team/backend/api', reason: 'The pipeline needs .NET 10', change: 'The target framework moves to net10.0' })
```
