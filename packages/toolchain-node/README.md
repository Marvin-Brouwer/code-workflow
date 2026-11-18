# `@mesh-flow/toolchain-node`

The Node.js toolchain for mesh-flow: the npm registry for the sandbox's `registries`, so `npm ci`, `pnpm install`, `yarn install` and `bun install` restore in a sandbox that has no network of its own. The package ships no agents.

## Usage

List `npmRegistry` in the sandbox's `registries`:

```ts
// main.mts
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { npmRegistry } from '@mesh-flow/toolchain-node'
import { fixIssue } from './workflows/fix-issue.mts'

export default defineMeshFlow({
	sandbox: image({
		name: 'node:26-slim',
		registries: [npmRegistry],
	}),
	workflows: [
		userTrigger(fixIssue),
	],
})
```

- Every fetch goes through the run's package proxy and the gateway, which fetches it on the host (see [`@mesh-flow/core`](../core/README.md#packages)). Nothing in a checkout changes: the package managers ask for `registry.npmjs.org` as they always do.
- Package documents and tarballs are reachable. `/-/`, the registry's own API (search, audit, users), isn't: restore doesn't need it, so `npm audit` doesn't work in the sandbox.
- Only reads go through: the proxy refuses anything but a `GET`, so nothing can publish.

Code fetches from it with `fetchPackage` from `@mesh-flow/core`:

```ts
import { fetchPackage, workflow } from '@mesh-flow/core'
import { npmRegistry } from '@mesh-flow/toolchain-node'
import { z } from 'zod'

/** The part of an abbreviated npm package document this workflow reads. */
const PackageDocument = z.object({ versions: z.record(z.string(), z.unknown()) })

export const zodVersions = workflow('zod-versions', async ({ abortSignal }) => {
	const document = await fetchPackage(
		{
			registry: npmRegistry,
			path: '/zod',
			accept: 'application/vnd.npm.install-v1+json',
		},
		abortSignal,
	)
	const { versions } = PackageDocument.parse(JSON.parse(document.body.toString('utf8')))
	return Object.keys(versions)
})
```

## Development

```sh
pnpm --filter @mesh-flow/toolchain-node typecheck
pnpm --filter @mesh-flow/toolchain-node test
pnpm --filter @mesh-flow/toolchain-node build
```
