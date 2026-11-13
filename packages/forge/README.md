# @mesh-flow/forge

What the mesh-flow connectors of code forges share, so `@mesh-flow/github` and `@mesh-flow/gitlab`
work the same way: checkouts and pushes over git bundles, describing a branch, watching a review and
sorting its comments, and on the host the clones, retries and signed posts.

Workflows don't use this package: they use a connector. It is for writing one.

## The sandbox's side

A connector checks a repository out with `checkoutRepository`, which clones on the host through the
connector's own tool and reuses a checkout that is there already:

```ts
import { checkoutRepository, type Checkout } from '@mesh-flow/forge'

const repository: Checkout = await checkoutRepository(
	{ repository: 'group/project', branch: 'fix-login', folder: 'project', remoteUrl, clone: stubs.cloneRepository },
	context,
)
```

`describeChange`, `triageItems` and `watchReview` hold the loops and the watch of a connector's
`describe`, `triage` and `review`. The connector says how its forge is read and written:

```ts
import { changeTextSchema, describeChange, type DescribeForge } from '@mesh-flow/forge'

const MergeRequestText = changeTextSchema({ maxTitleCharacters: 255, maxDescriptionCharacters: 1_000_000, request: 'merge request' })

const gitlabDescribe: DescribeForge<Repository, MergeRequest, MergeRequestRef> = {
	terms: { forge: 'GitLab', request: 'merge request', toolPrefix: 'gitlab' },
	layout: gitlabLayout,
	text: MergeRequestText,
	sameRepository: (one, other) => one === other,
	findOpen: (repository) => findOpenMergeRequest(repository),
	read: (ref) => mergeRequest(ref),
	head: (repository, pushed) => branchHeadOf(repository, pushed),
}

export function describe(agent: Agent, repository: Repository, options: DescribeOptions = {}) {
	return describeChange(agent, repository, gitlabDescribe, options)
}
```

## The host's side

`@mesh-flow/forge/host` has the bare clones that fetch and push with the credential, a `fetch` that
tries again when the connection drops, one call at a time per key, and the footer every post is
signed with:

```ts
import { defaultFetchRetry, gitRemote, retryingFetch, signed } from '@mesh-flow/forge/host'

const remote = gitRemote({
	directory,
	remoteUrl: (repository) => `${url}/${repository}.git`,
	cloneSegments: (repository) => repository.split('/'),
	credentialEnv: async (context) => basicAuthHeaderEnv('oauth2', await token(context)),
})
const fetch = retryingFetch(globalThis.fetch, defaultFetchRetry)
const body = signed('Looks good.', context.runId, [`reply:${item}`])
```
