# @mesh-flow/forge

What the mesh-flow connectors of code forges share, so `@mesh-flow/github` and `@mesh-flow/gitlab`
work the same way: checkouts and pushes over git bundles, describing a branch, watching a review and
sorting its comments, and on the host the clones, retries and signed posts.

Workflows don't use this package: they use a connector. It is for writing one.

## The sandbox's side

A connector defines its git tools with `gitTools`, and checks a repository out with
`checkoutRepository`, which clones on the host through the clone tool and reuses a checkout that is
there already:

```ts
import { hostToolStub, type ToolContext } from '@mesh-flow/core'
import { checkoutRepository, gitTools, type Checkout } from '@mesh-flow/forge'
import { z } from 'zod'

declare const context: ToolContext

const ProjectPath = z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/)
const { cloneRepository } = gitTools({ prefix: 'gitlab', forge: 'GitLab', repositoryTerm: 'project', repository: ProjectPath })

const repository: Checkout = await checkoutRepository(
	{
		repository: 'group/project',
		branch: 'fix-login',
		folder: 'project',
		remoteUrl: 'https://gitlab.example.com/group/project.git',
		clone: hostToolStub(cloneRepository),
	},
	context,
)
```

`describeChange`, `triageItems` and `watchReview` hold the loops and the watch of a connector's
`describe`, `triage` and `review`. The connector says how its forge is read and written:

```ts
import type { Agent } from '@mesh-flow/core'
import {
	branchHeadOf,
	changeTextSchema,
	describeChange,
	type ChangeRequest,
	type ChangeRequestLayout,
	type Checkout,
	type DescribeChangeOptions,
	type DescribeForge,
} from '@mesh-flow/forge'

interface MergeRequestRef {
	readonly repository: string
	readonly number: number
}

declare const layout: ChangeRequestLayout
declare function findOpenMergeRequest(repository: Checkout): Promise<ChangeRequest | undefined>
declare function mergeRequest(ref: MergeRequestRef): Promise<ChangeRequest>

const MergeRequestText = changeTextSchema({ maxTitleCharacters: 255, maxDescriptionCharacters: 1_000_000, request: 'merge request' })

const gitlabDescribe: DescribeForge<Checkout, ChangeRequest, MergeRequestRef> = {
	terms: { forge: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' },
	layout,
	text: MergeRequestText,
	sameRepository: (one, other) => one === other,
	findOpen: (repository) => findOpenMergeRequest(repository),
	read: (ref) => mergeRequest(ref),
	head: (repository, pushed) => branchHeadOf(repository, pushed),
}

export function describe(agent: Agent, repository: Checkout, options: DescribeChangeOptions<MergeRequestRef, never> = {}) {
	return describeChange(agent, repository, gitlabDescribe, options)
}
```

## The host's side

`@mesh-flow/forge/host` has the bare clones that fetch and push with the credential and the host
halves of the git tools, a `fetch` that tries again when the connection drops, one call at a time
per key, the footer every post is signed with, and the replies to review items:

```ts
import type { GitTools } from '@mesh-flow/forge'
import { defaultFetchRetry, gitHostTools, gitRemote, retryingFetch, signed } from '@mesh-flow/forge/host'
import type { HostToolContext } from '@mesh-flow/gateway'
import { basicAuthHeaderEnv } from '@mesh-flow/git'

declare const context: HostToolContext
/** The connector's git tools, as `gitTools` defined them. */
declare const gitlabGitTools: GitTools
declare function token(context: HostToolContext): Promise<string>

const remote = gitRemote({
	directory: '/var/lib/mesh-flow/gitlab',
	remoteUrl: (project) => `https://gitlab.example.com/${project}.git`,
	cloneSegments: (project) => project.split('/'),
	credentialEnv: async (context) => basicAuthHeaderEnv('oauth2', await token(context)),
})
const tools = gitHostTools(remote, gitlabGitTools)
const fetch = retryingFetch(globalThis.fetch, defaultFetchRetry)
const body = signed('Looks good.', context.runId, ['reply:note/12'])
```

`replyToItem` and `showItemsBeingRead` answer review items and show them as being read, through
the connector's `ReviewComments`: where its forge keeps replies, and how it reacts and posts.
