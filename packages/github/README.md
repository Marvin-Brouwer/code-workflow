# `@mesh-flow/github`

The GitHub connector for mesh-flow. A connector gives workflows one outside system; this one gives them GitHub: functions for code, tools for agents, a check for `verify`, and GitHub's webhooks for triggers. Whatever needs the token, API calls and git fetches and pushes, runs on the host through the gateway; the sandbox never has the token, and needs no network for git at all.

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
import { github, IssueParameters } from '@mesh-flow/github'
import { developer, writer } from '../agents.mts'

export const fixIssue = workflow('fix-issue', IssueParameters, async ({ parameters }) => {
	const issue = await github.collect(parameters.issue)
	const repository = await github.checkout({ repository: issue.repository, branch: `fix/${String(issue.number)}` })

	await developer.loop`
		Fix ${issue} in ${repository}. Push your changes with ${github.push(repository)}, then ${succeed()}.
		${limit({ minutes: 30 })}
	`

	const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))

	await github.review(pullRequest, {
		async comments(comments) {
			await developer.loop`
				Handle these review comments on ${pullRequest}: ${comments}.
				Change the code where a comment asks for it, push with ${github.push(repository)},
				and reply to every comment with ${github.reply(pullRequest)}. When every comment is handled, ${succeed()}.
			`
			await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
		},
	})
})
```

### Issues

`IssueParameters` is what a workflow on one issue takes, `{ issue }`, where `github.issue` is the issue itself, `{ repository: 'owner/name', number }`; a workflow that takes more declares `{ ...IssueParameters, reviewer: z.string() }`. `github.collect` reads the issue and writes it as Markdown into `issues/` in the workspace; in a prompt it renders as that file's absolute path, so the agent reads as much of it as it needs, also from inside a checkout. `github.comment(issue, body, { key })` updates its earlier comment with the same key instead of adding one, `github.label(issue, labels)` adds labels, `github.close(issue)` closes it.

### Repositories

`github.checkout({ repository, branch })` puts a checkout of the repository in the workspace, named after the repository, on the branch, made from the default branch when GitHub doesn't have it yet. In a prompt it renders as its path. A checkout of the repository that is already there is reused, and switched to the branch when it is on another; one folder holds one repository, so a second repository with the same name in one run is an error.

`github.push(repository)` is a tool: it commits every change in the checkout with the message it's given (what changed and why, which is what `describe` later reads) and pushes the branch. Code calls it too, as a function, and `openPullRequest` calls it first.

The clone comes from the host as a git bundle, and what the agent pushes goes back as one, so the sandbox needs no credential and no network for git. The bundle holds the whole history, which is fine for most repositories and slow for a huge one.

### Pull requests

`github.describe(agent, repository, { issue, pullRequest, limit })` has the workflow's agent write the pull request's title and description, in one loop that ends in `succeed(PullRequestText)`. Code reads what the agent needs before the loop starts:

- the branch's commits and `git diff --stat` against the default branch;
- the whole diff, as a file in `pull-requests/` in the workspace;
- the repository's pull request template;
- the settings that lint commit messages or pull request titles: commitlint's settings file or its key in `package.json`, and GitHub workflows that run commitlint or a PR title check.

The template and the lint settings are read as the default branch has them. The branch is described as it is committed: changes left uncommitted aren't in it. A branch without commits on top of the default branch is refused before the loop starts. The agent fills the template in, or writes `## What changes`, `## Why` and `## Testing` without one, and keeps the title and description to the lint settings, or the title under 72 characters without them. The title is one line of at most 256 characters, and the description at most 60,000. The prompt asks for what the branch changes against the default branch and why, as it is now: never what happened on the way there, so a description written after a review round doesn't read like a changelog of rounds.

It resolves to `{ title, description, describedSha, closes }`, ready for `openPullRequest` or `updatePullRequest` as it is: `describedSha` is the commit it was written for, and `closes` the issue. It writes nothing to GitHub itself. With `pullRequest`, it describes that pull request again: the agent starts from its current title and description and rewrites them for the branch as it was pushed, since that is what the pull request shows. When they already cover that commit, or the pull request is closed, no loop runs and the current text comes back, so calling it after every round of review costs a look. A pull request of another branch is refused. Pass `issue` again: without it, `closes` is left out and `updatePullRequest` drops the `Fixes` line.

`github.openPullRequest(repository, { title, description, describedSha, closes })` pushes, then opens a pull request from the branch onto the default branch, or gives the open one for the branch the title and description. An open pull request whose description was already written for that commit keeps it, so a run that starts over doesn't replace the text that was reviewed. With `closes`, `Fixes #7` goes in the footer, next to the run id. The description is signed like every post, and marked with the commit it describes (`describedSha`, else the pushed head). Since it pushes, it commits what was left uncommitted after `describe` ran; the next `describe` with `pullRequest` covers that commit. In a prompt it renders as its URL. `github.pullRequest(ref)` reads one as it is now.

`github.updatePullRequest(pullRequest, { title, description, describedSha, closes })` gives a pull request new text. It writes nothing when the pull request already says this, or when it's closed, since a merged pull request keeps the text it was reviewed with; `skipped` on the result says which. GitHub doesn't notify on an edit of the description.

`github.review(pullRequest, handlers, { every, toleratedOutage })` watches a pull request until it's merged or closed and resolves to `{ state, pullRequest }`. `comments` gets what reviewers said since the last look, oldest first and in one call per look, each item once; what the run posted itself is left out, found by a marker every comment it posts carries. It's never left out by author, since the token is often the reviewer's own. Before the handler runs, each item gets 👀 on GitHub, so the reviewer sees it is being read: a reaction where GitHub takes one (not on a review), and a "👀 Reading..." reply, in the line comment's thread or on the conversation, that the first answer to the item replaces, taking the reaction off again. GitHub notifies on a new comment, not on an edit, so the reviewer is notified of the "Reading..." reply and finds the answer in its place. When the 👀 can't be shown, say the comment was deleted since, the item is handed to the handler all the same. Everything the connector posts ends in a footer naming `@mesh-flow/*` and the run id. Each item has an `id` such as `review-comment/12` that `github.reply(pullRequest)`, the agent's tool, answers in the right place. `checksFailed` gets the failed checks of a commit, once per commit, once every check on it has completed; a commit whose checks haven't appeared yet is looked at again. It looks every 10 seconds unless `every` says otherwise, waiting on the engine's clock. A look takes about four reads, but the host asks for what it read before with its ETag, and GitHub answers a read that didn't change with a 304, which doesn't count against the token's 5,000 requests an hour. So a pull request that sits idle in review costs next to nothing; only a look that finds something new counts. A look that fails on something that may pass, such as a dropped connection or GitHub answering 5xx after the host's own retries, is tried again on the next one; `review` only gives up with the error once `toleratedOutage / every` looks in a row have failed (`toleratedOutage` defaults to 10 minutes; the time the failing calls take comes on top). A bad token, a missing permission or a pull request that's gone fails at once.

`github.checksPass(pullRequest, { every, appearWithin, toleratedOutage })` is a check for `verify`: it waits for the checks on the head commit to complete and reports each failed one as a finding. Checks take a while to appear after a push, so a commit without any is looked at again until `appearWithin` (default 10 minutes) has passed; a repository without checks passes after that. Like `review`, it looks again after a failed look, until `toleratedOutage / every` looks in a row have failed (`toleratedOutage` defaults to 10 minutes).

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
		// Labelling an issue ai-fix starts fixIssue with { issue }. Only compiles for a workflow that takes IssueParameters.
		github.onIssueLabeled(fixIssue, 'ai-fix'),
		// Any event schema works with webhook; the filter is in the structure, so other deliveries get a 4xx.
		webhook(triage, github.issueCommentCreated.transform((event) => ({ issue: { repository: event.repository.full_name, number: event.issue.number } })), github.triggerOptions),
	],
})
```

Set the webhook's secret with `mesh-flow webhook secret <app> <webhook> --generate` and paste it into GitHub, with the webhook URL `mesh-flow serve --webhook-port` prints.

## The host half

`@mesh-flow/github/host` is what the engine loads: `connector`, with the host halves of every tool. They take the token from the gateway's credential store under `github/token` on every call, so a new token counts at once, try reads again when the connection drops or GitHub answers 5xx or 429 (never a write, which may have gone through), report what may still pass after that as transient, and keep one bare clone per repository in the connector's directory in the engine's home, which runs share one call at a time. For a test, `githubHostTools` points them at servers of your own:

```ts
import { githubHostTools } from '@mesh-flow/github/host'

const tools = githubHostTools({
	directory: '/tmp/github-host',
	apiUrl: 'http://127.0.0.1:4010',
	remoteUrl: (repository) => `file:///tmp/remotes/${repository}.git`,
	retry: { attempts: 1, firstDelayMs: 0, longestRetryAfterMs: 0, attemptTimeoutMs: 1000 },
})
```

`retry` sets how requests are tried again (`defaultFetchRetry`: five attempts over about fifteen seconds); a test can turn it off as above, so a failing server fails at once.

## Development

```sh
pnpm --filter @mesh-flow/github typecheck
pnpm --filter @mesh-flow/github test
pnpm --filter @mesh-flow/github build
```

Tests run against an in-memory GitHub API and a local bare repository, so they need no token and no network. They need `git` on the machine.
