# `@mesh-flow/github`

The GitHub connector for mesh-flow: functions for code, tools for agents, a check for `verify`, and GitHub's webhooks for triggers. Whatever needs the token, API calls and git fetches and pushes, runs on the host through the gateway; the sandbox never has the token, and needs no network for git at all.

## Setup

Install the package where `mesh-flow serve` runs, add it as a connector and set the token. A fine-grained token with contents, issues and pull requests on the repositories the workflows touch is enough.

```bash
pnpm add @mesh-flow/github
mesh-flow connector add @mesh-flow/github
mesh-flow credential set github/token < token.txt
```

The sandbox image needs `git` next to `node`: `node:22-bookworm` has both, `node:22-slim` doesn't.

## Usage

```ts
import { limit, succeed, workflow } from '@mesh-flow/core'
import { github } from '@mesh-flow/github'
import { developer } from '../agents.mts'

export const fixIssue = workflow('fix-issue', { issue: github.issue }, async ({ parameters }) => {
	const issue = await github.collect(parameters.issue)
	const repository = await github.checkout({ repository: issue.repository, branch: `fix/${String(issue.number)}` })

	await developer.loop`
		Fix ${issue} in ${repository}. Push your changes with ${github.push(repository)}, then ${succeed()}.
		${limit({ minutes: 30 })}
	`

	const pullRequest = await github.openPullRequest(repository, { title: issue.title, description: `Fixes #${String(issue.number)}.` })

	await github.review(pullRequest, {
		comments: (comments) => developer.loop`
			Handle these review comments on ${pullRequest}: ${comments}.
			Change the code where a comment asks for it, push with ${github.push(repository)},
			and reply to every comment with ${github.reply(pullRequest)}. When every comment is handled, ${succeed()}.
		`,
	})
})
```

### Issues

`github.issue` is the parameter schema, `{ repository: 'owner/name', number }`. `github.collect` reads the issue and writes it as Markdown into `issues/` in the workspace; in a prompt it renders as that file's path, so the agent reads as much of it as it needs. `github.comment(issue, body, { key })` updates its earlier comment with the same key instead of adding one, `github.label(issue, labels)` adds labels, `github.close(issue)` closes it.

### Repositories

`github.checkout({ repository, branch })` puts a checkout of the repository in the workspace, named after the repository, on the branch, made from the default branch when GitHub doesn't have it yet. In a prompt it renders as its path. A checkout that is already there is reused.

`github.push(repository)` is a tool: it commits every change in the checkout with the message it's given and pushes the branch. Code calls it too, as a function, and `openPullRequest` calls it first.

The clone comes from the host as a git bundle, and what the agent pushes goes back as one, so the sandbox needs no credential and no network for git. The bundle holds the whole history, which is fine for most repositories and slow for a huge one.

### Pull requests

`github.openPullRequest(repository, { title, description })` pushes, then opens a pull request from the branch onto the default branch, or returns the open one for the branch. In a prompt it renders as its URL. `github.pullRequest(ref)` reads one as it is now.

`github.review(pullRequest, handlers, { every })` watches a pull request until it's merged or closed and resolves to `{ state, pullRequest }`. `comments` gets what reviewers said since the last look, oldest first and in one call per look, with the run's own comments left out; each item has an `id` such as `review-comment/12` that `github.reply(pullRequest)`, the agent's tool, answers in the right place. `checksFailed` gets the failed checks of a commit, once per commit. It looks every 30 seconds unless `every` says otherwise, waiting on the engine's clock.

`github.checksPass(pullRequest)` is a check for `verify`: it waits for the checks on the head commit to complete and reports each failed one as a finding.

### Webhooks

`@mesh-flow/github/hooks` has GitHub's events as zod schemas, with GitHub's signature scheme (`x-hub-signature-256`) and delivery header (`x-github-delivery`) filled in, and a ready-made trigger:

```ts
import { defineMeshFlow, image, userTrigger, webhook } from '@mesh-flow/core'
import { github } from '@mesh-flow/github/hooks'
import { fixIssue, triage } from './workflows/issues.mts'

export default defineMeshFlow({
	sandbox: image({ name: 'node:22-bookworm' }),
	workflows: [
		userTrigger(fixIssue),
		// Labelling an issue ai-fix starts fixIssue with { issue }. Only compiles for a workflow that takes github.issue.
		github.onIssueLabeled(fixIssue, 'ai-fix'),
		// Any event schema works with webhook; the filter is in the structure, so other deliveries get a 4xx.
		webhook(triage, github.issueCommentCreated.transform((event) => ({ issue: { repository: event.repository.full_name, number: event.issue.number } })), github.triggerOptions),
	],
})
```

Set the webhook's secret with `mesh-flow webhook secret <app> <webhook> --generate` and paste it into GitHub, with the webhook URL `mesh-flow serve --webhook-port` prints.

## The host half

`@mesh-flow/github/host` is what the engine loads: `connector`, with the host halves of every tool. They take the token from the gateway's credential store under `github/token` on every call, so a new token counts at once, and keep one bare clone per repository in the connector's directory in the engine's home. For a test, `githubHostTools({ directory, apiUrl, remoteUrl })` points them at a server of your own.

## Development

```sh
pnpm --filter @mesh-flow/github typecheck
pnpm --filter @mesh-flow/github test
pnpm --filter @mesh-flow/github build
```

Tests run against an in-memory GitHub API and a local bare repository, so they need no token and no network. They need `git` on the machine.
