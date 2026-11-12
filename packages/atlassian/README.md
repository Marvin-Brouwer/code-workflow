# `@mesh-flow/atlassian`

The Atlassian connector for mesh-flow. A connector gives workflows one outside system; this one gives them Jira and Confluence, on Atlassian Cloud and on Data Center: functions for code, tools for agents, and Jira's webhooks for triggers. Whatever needs a token runs on the host through the gateway; the sandbox never has one, and needs no network for Atlassian at all.

## Setup

Install the package where `mesh-flow serve` runs, add it as a connector and give it each product's site and token. They live in the gateway's credential store, the site too, since connectors have no settings of their own yet.

```bash
pnpm add @mesh-flow/atlassian
mesh-flow connector add @mesh-flow/atlassian
```

On Atlassian Cloud, an API token with the account's email. The same token serves Jira and Confluence, but each product has its own settings:

```bash
echo 'https://example.atlassian.net' | mesh-flow credential set jira/url
echo 'bot@example.com' | mesh-flow credential set jira/email
mesh-flow credential set jira/token < api-token.txt

echo 'https://example.atlassian.net' | mesh-flow credential set confluence/url
echo 'bot@example.com' | mesh-flow credential set confluence/email
mesh-flow credential set confluence/token < api-token.txt
```

On Data Center, a personal access token per product, and no email: a product without `<product>/email` is spoken to as Data Center, with the token as a bearer token. The URL is the product's own, with its context path if it has one:

```bash
echo 'https://jira.example.com' | mesh-flow credential set jira/url
mesh-flow credential set jira/token < jira-pat.txt

echo 'https://wiki.example.com' | mesh-flow credential set confluence/url
mesh-flow credential set confluence/token < confluence-pat.txt
```

Set only the product a workflow uses. Every call reads the settings again, so a changed token counts at once.

## Usage

```ts
// workflows/develop.mts
import { succeed, workflow, workspace } from '@mesh-flow/core'
import { confluence, jira, JiraIssueParameters } from '@mesh-flow/atlassian'
import { planner } from '../agents.mts'

const Research = workspace.folder('research', { description: 'Research notes', minFiles: 1 })

export const develop = workflow('develop', JiraIssueParameters, async ({ parameters }) => {
	const story = await jira.collect(parameters.key)
	await jira.transition(story, 'In Progress')

	await planner.loop`
		Research ${story}. Find related issues with ${jira.search} and read them with ${jira.dump}.
		Look for the team's guidelines with ${confluence.search} and read them with ${confluence.dump}.
		Write your findings in ${Research}, then ${succeed(Research)}.
	`

	await jira.comment(story, 'Research is done, planning next.', { key: 'progress' })
})
```

### Jira

`JiraIssueParameters` is what a workflow on one issue takes, `{ key }`, where `jira.key` is an issue key such as `PROJ-123`; a workflow that takes more declares `{ ...JiraIssueParameters, reviewer: z.string() }`.

- `jira.collect(issue)` reads the issue, with its comments, links and subtasks, and writes it as Markdown into `jira/` in the workspace. In a prompt it renders as that file's absolute path, so the agent reads as much of it as it needs, also from inside a checkout. The description and comments come as Jira renders them, turned into Markdown; tables stay HTML.
- `jira.dump` is the same for agents: a tool that takes a key and answers with the dump's path.
- `jira.search` is a tool, and a function for code: it takes JQL and a `limit` (default 20, at most 100) and answers with keys, summaries, statuses, types and whether more issues match.
- `jira.transition(issue, status)` moves an issue to a status, by name and without regard to case, through the transition of its workflow that leads there. It does nothing when the issue has that status already, and throws, naming the statuses it can move to, when no transition leads there.
- `jira.comment(issue, body, { key })` comments in Markdown, which becomes Atlassian Document Format on Cloud and wiki markup on Data Center. With a `key`, commenting again with the same key updates the earlier comment instead of adding one, so a rerun stays tidy; the ids are kept in the issue property `mesh-flow.comments`. A comment a person deleted is posted again. Every comment ends in a line that names `@mesh-flow/*` and the run.

Each takes an issue by its key or as `collect` gave it.

### Confluence

- `confluence.collect(page)` reads a page, by its id or its URL, and writes it as Markdown into `confluence/` in the workspace; in a prompt it renders as that file's absolute path.
- `confluence.dump` is the same for agents.
- `confluence.search` is a tool, and a function for code: it takes the words to look for, a space key to look in and a `limit` (default 20, at most 50), and answers with ids, titles, spaces, URLs and excerpts.

Confluence is read through REST API v1, which Cloud and Data Center share; on Cloud it's under `/wiki`, which the connector adds to the site.

### Webhooks

`@mesh-flow/atlassian/hooks` has Jira's events as zod schemas, with the signature Jira sends for a webhook with a secret (`x-hub-signature`) and its delivery header (`x-atlassian-webhook-identifier`) filled in, and a ready-made trigger:

```ts
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { jira } from '@mesh-flow/atlassian/hooks'
import { develop } from './workflows/develop.mts'

export default defineMeshFlow({
	sandbox: image({ name: 'node:22-bookworm' }),
	workflows: [
		userTrigger(develop),
		// Labelling an issue ai-develop starts develop with { key }. Only compiles for a workflow that takes JiraIssueParameters.
		jira.onIssueLabeled(develop, 'ai-develop'),
	],
})
```

Point a Jira webhook for updated issues at it, with a secret. Jira's changelog can't be filtered by structure alone, so an update that doesn't add the label ends as a skipped run once the sandbox started; narrow the webhook in Jira with JQL, such as `labels = ai-develop`, so few others arrive. `jira.issueCreated`, `jira.issueUpdated` and `jira.commentCreated` work with `webhook` for anything else.

## Host

The `host` entry point is what `mesh-flow connector add` loads: `connector`, and `atlassianHostTools({ fetch })` for a test that points the tools at a fake. `settingNames('jira')` names a product's settings. Requests Jira or Confluence didn't answer, or answered 502, 503 or 504, are sent up to four times; a failure that may still pass after that reaches the sandbox marked transient.
