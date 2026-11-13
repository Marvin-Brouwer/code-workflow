# `@mesh-flow/code-repository`

What the mesh-flow connectors of code hosts share, so `@mesh-flow/github` and `@mesh-flow/gitlab` work the same way: checkouts and pushes over git bundles, describing a branch, watching a review and sorting its comments, and on the host the clones, retries and signed posts.

Workflows don't use this package: they use a connector. It is for writing one.

## The sandbox's side

A connector defines its git tools with `gitTools`, and checks a repository out with `checkoutRepository`, which clones on the host through the clone tool and reuses a checkout that is there already:

```ts
import { hostToolStub, type ToolContext } from '@mesh-flow/core'
import { checkoutRepository, gitTools, type Checkout } from '@mesh-flow/code-repository'
import { z } from 'zod'

declare const context: ToolContext

const ProjectPath = z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/)
const terms = { codeHost: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' }
const { cloneRepository } = gitTools({ terms, repositoryTerm: 'project', repository: ProjectPath })

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

`describeChange`, `triageItems` and `watchReview` hold the loops and the watch of a connector's `describe`, `triage` and `review`. The connector says how its code host is read and written:

```ts
import { tool, type Agent } from '@mesh-flow/core'
import {
	branchHeadOf,
	changeTextSchema,
	describeChange,
	type ChangeRequest,
	type ChangeRequestLayout,
	type Checkout,
	type DescribeChangeOptions,
	type DescribeCodeHost,
} from '@mesh-flow/code-repository'
import { z } from 'zod'

interface MergeRequestRef {
	readonly repository: string
	readonly number: number
}

declare const layout: ChangeRequestLayout
declare function findOpenMergeRequest(repository: Checkout): Promise<ChangeRequest | undefined>
declare function mergeRequest(ref: MergeRequestRef): Promise<ChangeRequest>

/** The connector's tool that reads which commit a checkout's branch is at, which also tells an agent. */
const branchHead = (repository: Checkout) =>
	tool('gitlabBranchHead', {
		description: `Reads which commit the branch of ${repository.directory} is at`,
		input: z.object({ pushed: z.boolean() }),
		action: ({ pushed }, context) => branchHeadOf(repository, pushed, context),
	})

const MergeRequestText = changeTextSchema({ maxTitleCharacters: 255, maxDescriptionCharacters: 1_048_576, request: 'merge request' })

const gitlabDescribe: DescribeCodeHost<Checkout, ChangeRequest, MergeRequestRef> = {
	terms: { codeHost: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' },
	layout,
	text: MergeRequestText,
	sameRepository: (one, other) => one === other,
	findOpen: (repository) => findOpenMergeRequest(repository),
	read: (ref) => mergeRequest(ref),
	head: (repository, pushed) => branchHead(repository)({ pushed }),
}

export function describe(agent: Agent, repository: Checkout, options: DescribeChangeOptions<MergeRequestRef, never> = {}) {
	return describeChange(agent, repository, gitlabDescribe, options)
}
```

`untilCompleted(look, { every, appearWithin, toleratedOutage })` is the wait of a check such as `github.checksPass`: it looks at a commit's checks until they completed, and resolves to the ones that failed. `ReplyStage`, `defaultReplyStage`, `GoneReply`, `isGoneReply` and `UpdateSkip` are the schemas the connectors' reply and update tools share.

```ts
import { check } from '@mesh-flow/core'
import { untilCompleted, type CommitChecks } from '@mesh-flow/code-repository'

declare function pipelineOf(sha: string): Promise<CommitChecks<{ readonly name: string }>>

const pipelinePasses = (sha: string) =>
	check('pipeline', async () => {
		const failures = await untilCompleted(() => pipelineOf(sha), { every: { seconds: 10 } })
		return failures.map((failure) => ({ source: `pipeline: ${failure.name}`, message: 'failed' }))
	})
```

## The host's side

`@mesh-flow/code-repository/host` has the bare clones that fetch and push with the credential and the host halves of the git tools, a `fetch` that tries again when the connection drops, one call at a time per key, the footer every post is signed with, and the replies to review items:

```ts
import type { GitTools } from '@mesh-flow/code-repository'
import { defaultFetchRetry, gitHostTools, gitRemote, retryingFetch, signed } from '@mesh-flow/code-repository/host'
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

`replyToItem` and `showItemsBeingRead` answer review items and show them as being read, through the connector's `ReviewComments`: where its code host keeps replies, and how it reacts and posts.
