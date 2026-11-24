# `@mesh-flow/atlassian`

The Atlassian connector for mesh-flow. A connector gives workflows one outside system; this one gives them Jira and Confluence, on Atlassian Cloud and on Data Center: functions for code, tools for agents, and Jira's webhooks for triggers. Whatever needs a token runs on the host through the gateway; the sandbox never has one, and needs no network for Atlassian at all.

## Setup

Install the package where `mesh-flow serve` runs, add it as a connector and give it the site and token. They live in the gateway's credential store, the site too, since connectors have no settings of their own yet.

```sh
pnpm add @mesh-flow/atlassian
mesh-flow connector add @mesh-flow/atlassian
```

On Atlassian Cloud, one site and one API token, with the account's email, for Jira and Confluence both:

```sh
echo 'https://example.atlassian.net' | mesh-flow credential set atlassian/url
echo 'bot@example.com' | mesh-flow credential set atlassian/email
mesh-flow credential set atlassian/token < api-token.txt
```

On Data Center, each product has its own site and personal access token, and no email. A product whose `<product>/url` is set is spoken to as Data Center, with the token as a bearer token; one without uses the Cloud settings. The URL is the product's own, with its context path if it has one:

```sh
echo 'https://jira.example.com' | mesh-flow credential set jira/url
mesh-flow credential set jira/token < jira-pat.txt

echo 'https://wiki.example.com' | mesh-flow credential set confluence/url
mesh-flow credential set confluence/token < confluence-pat.txt
```

On Data Center, set only the product a workflow uses. Every call reads the settings again, so a changed token counts at once. `mesh-flow deploy` and a trigger say what's missing: the Cloud settings when no product has a Data Center site, otherwise the token of each product that has one. Cloud used to be set per product too (`jira/url`, `jira/email`, `jira/token`); a product that still has `<product>/email` is that old setup, not Data Center, and both its calls and the check say to move it to the `atlassian/` settings.

## Usage

```ts
// workflows/develop.mts
import { confluence, jira, JiraIssueParameters } from '@mesh-flow/atlassian'
import { succeed, workflow, workspace, type Agent } from '@mesh-flow/core'

// The workflow repository's own agent: packages ship none.
declare const planner: Agent

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

- `jira.collect(issue)` reads the issue, with its comments, links and subtasks, and writes it as Markdown into `jira/` in the workspace. In a prompt it renders as that file's absolute path, so the agent reads as much of it as it needs, also from inside a checkout.
  - The issue's metadata (key, summary, URL, type, status, priority, assignee, reporter, labels, components, parent, dates, links, subtasks and attachments) is YAML frontmatter. The body is its description and comments, as Jira renders them, turned into Markdown; tables stay HTML.
  - A mention of a person is `` `@mention({ name: "Rita Reporter", email: "rita@example.com", id: "5b10" })` ``. The connector asks the site who it is; the email is left out where the site keeps it private, as Cloud often does, and `id` is the account id on Cloud and the username on Data Center. A person the site can't tell about keeps the name and id the mention links to.
  - Image attachments of up to 5 MB each, and 20 MB per issue in all, are brought into the workspace next to the issue's file, in a folder named after the issue, and the description and comments link to that copy, in tables too. Every attachment is listed in the frontmatter: by its `file`, relative to the issue's file, when it was brought, and by its `url` on the site otherwise. Only files on the site itself are read, so the token never goes elsewhere.
- `jira.dump` is the same for agents: a tool that takes a key and answers with the dump's path.
- `jira.search` is a tool, and a function for code: it takes JQL and a `limit` (default 20, at most 100) and answers with keys, summaries, statuses, types and whether more issues match.
- `jira.transition(issue, status)` moves an issue to a status, by name and without regard to case, through the transition of its workflow that leads there. It does nothing when the issue has that status already, and throws, naming the statuses it can move to, when no transition leads there.
- `jira.comment(issue, body, { key })` comments in Markdown, which becomes Atlassian Document Format on Cloud and wiki markup on Data Center. With a `key`, commenting again with the same key updates the earlier comment instead of adding one, so a rerun stays tidy; each key's comment id is kept in an issue property of its own, `mesh-flow.comment.<hash of the key>`. Comments with one key wait for each other, so two at once post one comment. A comment a person deleted is posted again. A run stopped between posting a comment and keeping its id posts that comment once more on its rerun. Every comment ends in a line that names `@mesh-flow/*` and the run.

Each takes an issue by its key or as `collect` gave it.

### Confluence

- `confluence.collect(page)` reads a page, by its id or its URL, and writes it as Markdown into `confluence/` in the workspace, with its id, title, URL, space, version and last update as YAML frontmatter, and mentions written as for an issue; in a prompt it renders as that file's absolute path.
- `confluence.dump` is the same for agents.
- `confluence.search` is a tool, and a function for code: it takes the words to look for, a space key to look in and a `limit` (default 20, at most 50), and answers with ids, titles, spaces, URLs and excerpts.

Confluence is read through REST API v1, which Cloud and Data Center share; on Cloud it's under `/wiki`, which the connector adds to the site.

### Webhooks

`@mesh-flow/atlassian/hooks` has Jira's events as zod schemas, with the signature Jira sends for a webhook with a secret (`x-hub-signature`) and its delivery header (`x-atlassian-webhook-identifier`) filled in, and a ready-made trigger:

```ts
import { jira } from '@mesh-flow/atlassian/hooks'
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { develop } from './workflows/develop.mts'

export default defineMeshFlow({
	sandbox: image({ name: 'node:26-bookworm' }),
	workflows: [
		userTrigger(develop),
		// Labelling an issue ai-develop starts develop with { key }. Only compiles for a workflow that takes JiraIssueParameters.
		jira.onIssueLabeled(develop, 'ai-develop'),
	],
})
```

Point a Jira webhook for updated issues at it, with a secret. Jira's changelog can't be filtered by structure alone, so an update that doesn't add the label ends as a skipped run once the sandbox started; narrow the webhook in Jira with JQL, such as `labels = ai-develop`, so few others arrive. The run's own transitions and comments on the issue are updates too, and still match that JQL: each starts a sandbox that ends as a skipped run. Leaving the statuses the run moves an issue to out of the JQL, such as `labels = ai-develop AND status = "To Do"`, keeps most of them out. `jira.issueCreated`, `jira.issueUpdated` and `jira.commentCreated` work with `webhook` for anything else.

Set the webhook's secret with `mesh-flow webhook secret <app> <webhook> --generate` and paste it into Jira as the webhook's secret, with the webhook URL `mesh-flow serve --webhook-port` prints.

On Data Center, a webhook has a secret, and so a signature, only on recent versions; the engine needs one, so an older site can't start runs this way. A delivery without `x-atlassian-webhook-identifier` is told apart by a hash of its body, which holds a timestamp, so a redelivery still reuses its run.

## The host half

`@mesh-flow/atlassian/host` is what the engine loads: `connector`, with the host halves of every tool, and `atlassianHostTools` for a test that points them at a fake. `cloudCredentialNames` names the Cloud credentials, `dataCenterCredentialNames('jira')` a product's Data Center ones.

```ts
import { atlassianHostTools, defaultFetchRetry } from '@mesh-flow/atlassian/host'
import { duration } from '@mesh-flow/duration'

// A site that answers every request with an empty object, and retries once, almost at once.
const answersItself: typeof fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
const retry = {
	...defaultFetchRetry,
	waits: [duration.of('1ms')],
}
const tools = atlassianHostTools({ fetch: answersItself, retry })
```

Reads, searches and updates that Jira or Confluence didn't answer within half a minute, or answered 500, 502, 503, 504 or 429, are sent again, as by the code host connectors: up to five times over about fifteen seconds (`defaultFetchRetry`), or after the wait a `retry-after` asks for (`atlassianResends` says which requests). A failure that may still pass after that reaches the sandbox marked transient. A look-up of who a mention names is tried once: without an answer, the mention keeps what its link holds. A request that makes something, a comment or a transition, is sent once, since a retry after a lost answer would make it twice: a transition whose answer was lost counts as made when the issue has the status after all.

## Development

```sh
pnpm --filter @mesh-flow/atlassian typecheck
pnpm --filter @mesh-flow/atlassian test
pnpm --filter @mesh-flow/atlassian build
```

Tests run against in-memory Jira and Confluence sites, so they need no token and no network.

`test/jira.spec.md` and `test/confluence.spec.md` hold the whole Markdown an agent reads for one rich issue and one rich page, next to the tests that write them. A change to what the connector writes shows up there as a diff; after checking it, accept it with `pnpm --filter @mesh-flow/atlassian test -u`.
