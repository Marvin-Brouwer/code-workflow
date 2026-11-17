# `@mesh-flow/aws`

The AWS connector for mesh-flow: an IAM Identity Center session on the host, the role credentials and CodeArtifact tokens the host derives from it, package restores from CodeArtifact repositories, and `aws.checkSession` for workflows. None of the credentials ever enter the sandbox. The package ships no agents.

## Restoring from CodeArtifact

List the repository in the sandbox's `registries`. `dotnet restore` and `npm ci` in the sandbox then restore from it as the repository's own config names it, such as a `nuget.config` with the CodeArtifact URL; nothing in a checkout changes:

```ts
import { codeArtifact } from '@mesh-flow/aws'
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { develop } from './develop.mts'

export default defineMeshFlow({
	sandbox: image({
		name: 'node:26-slim',
		registries: ['nuget', codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })],
	}),
	workflows: [userTrigger(develop)],
})
```

- The run's package proxy takes the fetch for `<domain>-<owner>.d.codeartifact.<region>.amazonaws.com`, below the repository's `/nuget/<repository>/` and `/npm/<repository>/`, and the host fetches it with a CodeArtifact token from the session: a bearer token for npm, the password of the user `aws` for NuGet, as `aws codeartifact login` sets them up. The token goes to the repository's own domain only, and not along a redirect to a signed download.
- Only reads go through: the proxy refuses anything but a `GET`, so nothing can publish or delete.
- The packages are cached on the host, so a warm restore doesn't go to CodeArtifact. Whether a package comes from the repository or its upstreams stays CodeArtifact's setup.
- Without a session, the fetch waits for a sign-in like an AWS tool does, so a restore that hits it takes longer, or times out in the package manager if nobody signs in. A package manager that timed out and tries again finds the same code to approve: the sign-in goes on until its code runs out.
- `mesh-flow deploy` and a trigger say which AWS settings are still missing for an app that restores from CodeArtifact or calls an AWS tool.

Code fetches from it with `fetchPackage` from `@mesh-flow/core`, as from any registry the app restores from:

```ts
import { codeArtifact } from '@mesh-flow/aws'
import { fetchPackage, workflow } from '@mesh-flow/core'

const packages = codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })

export const packageIndex = workflow('package-index', async ({ abortSignal }) => {
	const index = await fetchPackage({ registry: packages, path: '/nuget/packages/v3/index.json' }, abortSignal)
	return index.body.toString('utf8')
})
```

## In a workflow

Nothing has to sign in first: an AWS tool that finds no session makes the run wait for a sign-in, and goes on once the user approved. `aws.checkSession` is for code that wants to make sure up front, such as before a long unattended stretch. It's a function and a tool, so an agent can call it too:

```ts
import { aws } from '@mesh-flow/aws'

await aws.checkSession({})
```

## Setup

Add the connector where `mesh-flow serve` runs, set where you sign in and the role to work with, and sign in:

```sh
pnpm add @mesh-flow/aws
mesh-flow connector add @mesh-flow/aws
echo 'https://example.awsapps.com/start' | mesh-flow credential set aws/start-url
echo 'eu-west-1' | mesh-flow credential set aws/sso-region
echo '123456789012' | mesh-flow credential set aws/account
echo 'Developer' | mesh-flow credential set aws/role
mesh-flow login aws
```

None of the four settings is a secret. They are in the credential store because it's the one settings store the engine has until the settings UI.

Signing in up front is optional: a run that needs AWS and finds no session waits for a sign-in, `mesh-flow list` shows it as `needs login: aws`, and `mesh-flow show <run>` or `mesh-flow login aws` shows where to approve it.

`mesh-flow login aws` uses Identity Center's device flow. It registers the engine with Identity Center (the registration lasts about 90 days, longer than any session), prints the URL to open and the code to check, and waits until you approve. The session's access token and refresh token, and the registration they belong to, go into the sealed credential store under `aws/session`.

## The host half

One sign-in lasts as long as Identity Center's session does, a limit its admin sets. The engine has no timer of its own. Every run on the engine shares the session, and an engine restart keeps it.

`openAwsSession` is what the host tools work with:

```ts
import { openAwsSession } from '@mesh-flow/aws/host'
import { keyFile, openCredentialStore } from '@mesh-flow/gateway'

const credentials = openCredentialStore('/srv/mesh-flow/credentials.json', keyFile('/srv/mesh-flow/store.key'))
const abortSignal = AbortSignal.timeout(30_000)
const session = openAwsSession({ credentials })
const { accessKeyId, secretAccessKey, sessionToken } = await session.roleCredentials(abortSignal)
const { token } = await session.codeArtifactToken({ domain: 'example', owner: '123456789012', region: 'eu-west-1' }, abortSignal)
```

- Role credentials come from the access portal for the account and role in the settings. They are kept in memory only, fetched again when they near their end, and at once when the settings change.
- The access token is renewed with the refresh token while the session lives, and the renewed session is written back, unless a new sign-in came between. A renewal runs to its end even when the call that started it stops, since Identity Center's old refresh token stops working once it hands out a new one.
- A CodeArtifact token is fetched with the role credentials and lasts as long as they do, so the two are renewed together.
- Once Identity Center ends the session, the last role credentials and tokens are used until they run out, so a restore under way isn't cut off. After that, every call throws an `AwsSignInNeededError`, and `status` says `sign-in-needed`. Thrown from a host tool, it makes the run wait for a sign-in and call the tool again.

The connector gets only the credentials named `aws/...`, so it can renew its session without reaching anything else in the store. `awsHostTools(session)` makes its host tools on a session, and `codeArtifactFetch(session)` how the gateway fetches from CodeArtifact on it; the connector shares one session between them.

## Development

The tests run against a fake of Identity Center's OIDC service, the access portal and CodeArtifact, on loopback: `openAwsSession`, `signIn` and `awsConnectorHost` take `endpoints` and a clock for that. A fake CodeArtifact repository checks the restores through the gateway. Checks against a real Identity Center and a real CodeArtifact repository are done by hand.
