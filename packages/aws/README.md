# `@mesh-flow/aws`

The AWS connector for mesh-flow: an IAM Identity Center session on the host, the role credentials and CodeArtifact tokens the host derives from it, and `aws.checkSession` for workflows. None of the credentials ever enter the sandbox. The package ships no agents.

The registry shim that restores packages from CodeArtifact through it comes next ([plan](../../docs/plans/aws-codeartifact.md)).

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

`mesh-flow login aws` uses Identity Center's device flow. It registers the engine with Identity Center once (the registration lasts about 90 days), prints the URL to open and the code to check, and waits until you approve. The session's access token and refresh token go into the sealed credential store under `aws/session`.

## The session

One sign-in lasts as long as Identity Center's session does, a limit its admin sets. The engine has no timer of its own. Every run on the engine shares the session, and an engine restart keeps it.

`openAwsSession` is what the host tools work with:

```ts
import { openAwsSession } from '@mesh-flow/aws/host'

const aws = openAwsSession({ credentials })
const { accessKeyId, secretAccessKey, sessionToken } = await aws.roleCredentials(abortSignal)
const { token } = await aws.codeArtifactToken({ domain: 'example', owner: '123456789012', region: 'eu-west-1' }, abortSignal)
```

- Role credentials come from the access portal for the account and role in the settings. They are kept in memory only, and fetched again when they near their end.
- The access token is renewed with the refresh token while the session lives, and the renewed session is written back.
- A CodeArtifact token is fetched with the role credentials and lasts as long as they do, so the two are renewed together.
- Once Identity Center ends the session, the last role credentials and tokens are used until they run out, so a restore under way isn't cut off. After that, every call throws an `AwsSignInNeeded`, and `status` says `sign-in-needed`. Thrown from a host tool, it makes the run wait for a sign-in and call the tool again.

The connector gets only the credentials named `aws/...`, so it can renew its session without reaching anything else in the store. `awsHostTools({ credentials })` makes its host tools on one session.

## Development

The tests run against a fake of Identity Center's OIDC service, the access portal and CodeArtifact, on loopback: `openAwsSession` and `signIn` take `endpoints` and a clock for that. A check against a real Identity Center is done by hand.
