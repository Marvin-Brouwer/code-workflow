# `@mesh-flow/gitlab`

The GitLab connector for mesh-flow, for gitlab.com and for a GitLab of your own. It gives workflows functions for code, tools for agents, a check for `verify`, and GitLab's webhooks for triggers. Whatever needs the token, API calls and git fetches and pushes, runs on the host through the gateway; the sandbox never has the token, and needs no network for git at all.

It works like `@mesh-flow/github`, and shares its parts through `@mesh-flow/forge`: what is said there about checkouts, `describe`, the edit check, `review`, `triage` and `reply` holds here, with merge requests for pull requests and notes for comments.

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
import { succeed, verify, workflow } from '@mesh-flow/core'
import { jira } from '@mesh-flow/atlassian'
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

`gitlab.searchRepositories` is a tool for an agent that has to find where a change goes: it searches the projects the token can see by words in their name, path or description, and lists each with the path `gitlab.checkout` takes.

`gitlab.checkout(project, { branch })` puts a checkout of the project in the workspace, in a folder named after the project's last segment, on the branch, made from the default branch when GitLab doesn't have it yet. A project is named by its whole path, groups and subgroups too: `team/backend/api`. `gitlab.push(repository)` is the tool that commits and pushes. Both go through the host as git bundles, as in `@mesh-flow/github`.

### Merge requests

`gitlab.describe(agent, repository, { closes, mergeRequest, limit })` has the agent write the title and description, from the branch's commits and diff, the project's merge request templates (the Markdown files in `.gitlab/merge_request_templates/`), and its settings that lint commit messages or titles: commitlint's, or a job in `.gitlab-ci.yml` or `.gitlab/ci/*.yml` that runs commitlint or a title check. The title is at most 255 characters. `closes` is the issue the merge request closes, by its `key`: `Fixes PROJ-7` goes in the footer, which GitLab's Jira integration acts on.

`gitlab.openMergeRequest`, `gitlab.updateMergeRequest` and `gitlab.mergeRequest` open, update and read merge requests as their GitHub counterparts do pull requests, with the same check for an edit made while the text was written. A merge request is named by its project and its iid, the number after `!`: `{ repository: 'team/backend/api', number: 7 }`.

### Review

`gitlab.review(mergeRequest, { comments, pipelineFailed }, { every, toleratedOutage })` watches a merge request until it's merged or closed. `comments` gets the notes reviewers wrote since the last look, on lines (`diff-note`) and on the merge request (`note`); GitLab's system notes and the run's own are left out. Before the handler runs, each note gets 👀 and a "👀 Reading..." reply in its thread, which the first answer replaces; a note on its own becomes a thread with the first reply, so every answer is next to what it answers. Each item has an id such as `note/12`, which `gitlab.reply(mergeRequest)` answers. `pipelineFailed` gets the failed jobs of the head commit's pipeline, once per commit, once the pipeline has completed. A job that may fail is left out.

`gitlab.triage(agent, repository, { mergeRequest, comments })` sorts a round of notes as `github.triage` does, and resolves to the changes asked for.

`gitlab.pipelinePasses(mergeRequest, { every, appearWithin, toleratedOutage })` is a check for `verify`: it waits for the head commit's pipeline to complete and reports each failed job as a finding. A pipeline that waits on a manual job counts as completed. A project without CI passes once no pipeline appeared within `appearWithin` (10 minutes).

### Packages

`gitlab.publishedPackages(mergeRequest, 'nuget')` resolves to the packages the merge published: it waits for the pipeline of the commit the merge left on the target branch, then lists the packages of that type in the project's package registry that this pipeline built, `{ name, version }` each. A merge request that isn't merged, a failed pipeline, or none within `appearWithin`, fails the call, since the packages a dependent project would take don't exist.

### Webhooks

`@mesh-flow/gitlab/hooks` has GitLab's events as zod schemas, `mergeRequestEvent(action)`, `mergeRequestNote` and `pipelineEvent(status)`, and `triggerOptions` with GitLab's secret header (`x-gitlab-token`) and delivery header (`x-gitlab-event-uuid`) filled in:

```ts
import { webhook } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab/hooks'

const merged = gitlab.mergeRequestEvent('merge').transform((event) => ({ project: event.project.path_with_namespace }))
export const onMerge = webhook(release, merged, { name: 'release-on-merge', ...gitlab.triggerOptions })
```

Set the webhook's secret with `mesh-flow webhook secret <app> <webhook> --generate` and paste it into GitLab as the webhook's secret token, with the webhook URL `mesh-flow serve --webhook-port` prints.
