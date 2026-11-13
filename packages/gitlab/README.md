# `@mesh-flow/gitlab`

The GitLab connector for mesh-flow, for gitlab.com and for a GitLab of your own. It gives workflows functions for code, tools for agents, a check for `verify`, and GitLab's webhooks for triggers. Whatever needs the token, API calls and git fetches and pushes, runs on the host through the gateway; the sandbox never has the token, and needs no network for git at all.

It shares its checkouts, `describe`, `review`, `triage` and `reply` with the other code host connectors through `@mesh-flow/code-repository`, so a workflow reads the same on each.

## Setup

Install the package where `mesh-flow serve` runs, add it as a connector and set the token: a personal, group or project access token with the `api` scope. For a GitLab of your own, set its URL too; without one, the connector goes to gitlab.com.

```bash
pnpm add @mesh-flow/gitlab
mesh-flow connector add @mesh-flow/gitlab
mesh-flow credential set gitlab/token < token.txt
mesh-flow credential set gitlab/url # https://gitlab.example.com
```

The sandbox image needs `git` next to `node`.

## Usage

The agents are the workflow repository's own; the package takes them as parameters. A merge request often closes a Jira issue, such as one `@mesh-flow/atlassian` collected:

```ts
// workflows/develop.mts
import { jira } from '@mesh-flow/atlassian'
import { succeed, verify, workflow } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab'
import { developer, writer } from '../agents.mts'

export const develop = workflow('develop', { key: jira.key }, async ({ parameters }) => {
	const story = await jira.collect(parameters.key)
	const repository = await gitlab.checkout('team/backend/api', { branch: `feature/${story.key}` })

	await developer.loop`Implement ${story} in ${repository}. Push with ${gitlab.push(repository)}, then ${succeed()}.`

	const mergeRequest = await gitlab.openMergeRequest(repository, await gitlab.describe(writer, repository, { closes: story }))

	await gitlab.review(mergeRequest, {
		pipelineFailed: ({ failures }) => developer.loop`
			The pipeline of ${mergeRequest} failed: ${failures}. Fix it in ${repository}, push with ${gitlab.push(repository)},
			and hand in with ${verify(gitlab.pipelinePasses(mergeRequest))}.
		`,
		async comments(comments) {
			const changes = await gitlab.triage(developer, repository, { mergeRequest, comments })
			if (changes.length === 0) return
			await developer.loop`
				Make these changes in ${repository}, as you planned them: ${changes}. Push with ${gitlab.push(repository)},
				then reply to every item with what you did, using ${gitlab.reply(mergeRequest)}. When every item is done, ${succeed()}.
			`
			await gitlab.updateMergeRequest(mergeRequest, await gitlab.describe(writer, repository, { closes: story, mergeRequest }))
		},
	})

	return { packages: await gitlab.publishedPackages(mergeRequest, 'nuget') }
})
```

### Projects

`gitlab.searchRepositories` is a tool for an agent that has to find where a change goes: it searches the projects the token's user is a member of by words in their name, path or description, and lists each with the path `gitlab.checkout` takes.

`gitlab.checkout(project, { branch })` puts a checkout of the project in the workspace, in a folder named after the project's last segment, on the branch, made from the default branch when GitLab doesn't have it yet. A project is named by its whole path, groups and subgroups too: `team/backend/api`. `gitlab.push(repository)` is the tool that commits and pushes. Both go through the host as git bundles: the host fetches and pushes with the token, and the sandbox only gets the commits.

### Merge requests

`gitlab.describe(agent, repository, { closes, mergeRequest, limit })` has the agent write the title and description, from the branch's commits and diff, the project's merge request templates (the Markdown files in `.gitlab/merge_request_templates/`), and its settings that lint commit messages or titles: commitlint's, or a job in `.gitlab-ci.yml` or `.gitlab/ci/*.yml` that runs commitlint or a title check. The title is at most 255 characters. `closes` is the issue the merge request closes, by its `key`: `Fixes PROJ-7` goes in the footer, which GitLab's Jira integration acts on.

`gitlab.openMergeRequest(repository, text)` opens the merge request of the checkout's branch onto its default branch, or takes the one that is open already, and gives it the text unless it was written for the same commit. GitLab keeps one open merge request per branch, so one onto another target fails the call, naming it. `gitlab.updateMergeRequest(mergeRequest, text)` writes new text, unless someone edited it since `describe` read it: then the person is asked whether to overwrite the edit first. A merged or closed merge request keeps its text. `gitlab.mergeRequest(ref)` reads one. A merge request is named by its project and its iid, the number after `!`: `{ repository: 'team/backend/api', number: 7 }`.

### Review

`gitlab.review(mergeRequest, { comments, pipelineFailed }, { every, toleratedOutage })` watches a merge request until it's merged or closed. `comments` gets the notes reviewers wrote since the last look, on lines (`diff-note`) and on the merge request (`note`); GitLab's system notes and the run's own are left out. Before the handler runs, each note gets 👀 and a "👀 Reading..." reply in its thread, which the first answer replaces; a note on its own becomes a thread with the first reply, so every answer is next to what it answers. In a project that requires every thread to be resolved before merging, such a thread needs resolving too. Each item has an id such as `note/12`, which `gitlab.reply(mergeRequest)` answers. `pipelineFailed` gets the failed jobs of the head commit's pipeline, once per commit, once the pipeline has completed. A job that may fail is left out.

`gitlab.triage(agent, repository, { mergeRequest, comments })` has the agent sort a round of notes into questions, changes it will make and changes it won't, in a loop that changes nothing. It answers the questions and the declined changes, puts the plan under each change it will make, and resolves to those changes.

`gitlab.pipelinePasses(mergeRequest, { every, appearWithin, toleratedOutage })` is a check for `verify`: it waits for the head commit's pipeline to complete and reports each failed job as a finding. The merge request's own pipeline counts first, the one GitLab gates the merge on: a merged results pipeline, which runs on GitLab's merge of the head into the target, counts as the head's. A pipeline that waits on a manual job counts as completed: nothing runs until someone starts it, so `review` reports the jobs that failed before it, if any, and a check that waits for it doesn't hang. A project without CI passes once no pipeline appeared within `appearWithin` (10 minutes).

### Packages

`gitlab.publishedPackages(mergeRequest, 'nuget')` resolves to the packages the merge published: it waits for the pipeline of the commit the merge left on the target branch, then lists the packages of that type in the project's package registry that this pipeline built, `{ name, version }` each, once GitLab has processed them. A package GitLab couldn't process fails the call. A merge request that isn't merged, a failed pipeline, one that waits for a person to start a job, or none within `appearWithin`, fails the call, since the packages a dependent project would take don't exist, or may not yet. GitLab may take `processWithin` (10 minutes) to process the uploaded packages.

### Webhooks

`@mesh-flow/gitlab/hooks` has GitLab's events as zod schemas, `mergeRequestEvent(action)`, `mergeRequestNote` and `pipelineEvent(status)`, and `triggerOptions` with GitLab's secret header (`x-gitlab-token`) and delivery header (`idempotency-key`, which stays the same when GitLab retries or resends a delivery; GitLab before 17.4 doesn't send it, and the engine tells deliveries apart by a hash of the body then) filled in:

```ts
import { webhook } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab/hooks'

const merged = gitlab.mergeRequestEvent('merge').transform((event) => ({ project: event.project.path_with_namespace }))
export const onMerge = webhook(release, merged, { name: 'release-on-merge', ...gitlab.triggerOptions })
```

Set the webhook's secret with `mesh-flow webhook secret <app> <webhook> --generate` and paste it into GitLab as the webhook's secret token, with the webhook URL `mesh-flow serve --webhook-port` prints.
