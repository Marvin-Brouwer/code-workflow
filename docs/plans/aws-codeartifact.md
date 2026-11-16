# Plan: AWS sign-in and CodeArtifact restores

Status: proposed 2026-11-16, not built. Covers the first part of roadmap step 5 of
[`../design.md`](../design.md#roadmap): an AWS session on the host that the user signs in to
interactively, `checkSession`, and package restores from a private CodeArtifact repository in the
sandbox. Publishing to CodeArtifact, other AWS operations and the package managers beyond npm and
NuGet come later.

## Goal

A big-repo run restores NuGet (and npm) packages from a real CodeArtifact repository, with no AWS
credential in the sandbox. When the AWS session is missing or expired, the run asks the user to
sign in and waits; it doesn't fail. One sign-in resumes every run waiting on it.

Done when: a run against the real CodeArtifact restores a package that is only there, on gVisor
and on microsandbox, starting from no session at all, and a run that started with a session that
expires before the restore asks again and goes on after the sign-in.

## What gets built

A new package, `@mesh-flow/aws`, a connector like the others: a sandbox half that workflows
import, and a host half the engine loads (`mesh-flow connector add @mesh-flow/aws`). AWS calls on
the host use the AWS SDK v3 clients (`@aws-sdk/client-sso-oidc`, `@aws-sdk/client-sso`,
`@aws-sdk/client-codeartifact`), not our own SigV4.

### 1. The session (host)

IAM Identity Center with the OIDC device flow, as [design section 7](../design.md#aws) says:

1. `RegisterClient` once per engine home (the client registration is kept, it lasts about 90 days).
2. `StartDeviceAuthorization` gives a verification URL and a user code.
3. The user opens the URL and approves. The host polls `CreateToken` meanwhile.
4. The access token and refresh token go into the sealed credential store (`aws/session`). They
   never leave the host.
5. Role credentials come from `GetRoleCredentials` for the configured account and role, are kept
   in memory only, and are refreshed while they're used. CodeArtifact's authorization token
   (`GetAuthorizationToken`, at most 12 hours) is fetched with them and cached the same way.

**One sign-in per Identity Center session, not per run.** The session belongs to the engine home,
so every run, every loop and `mesh-flow login aws` share it. Within its lifetime the host renews the
access token with the refresh token and the role credentials and CodeArtifact token from that, all
without asking. An engine restart keeps the session, since it's in the credential store.

**The session lasts as long as Identity Center says.** The engine has no timer of its own: the
user is asked again only when the Identity Center session ends, a limit its admin sets (8 hours by
default) and a refresh token doesn't outlive. Nothing to configure on the engine's side.

**A run that started can finish past the session's end, within limits.** What the host derives from
the session outlives it: role credentials last the permission set's session duration (1 to 12
hours, its admin's setting) from when they were fetched, and a CodeArtifact token lasts up to 12
hours, but no longer than the credentials it was fetched with (to check while building). So the host:

- fetches role credentials for the longest duration allowed, and fetches them again, with a new
  CodeArtifact token, whenever the current ones near their end while the session still lives;
- once the session has ended, keeps using the last ones until they expire, so a running restore
  isn't cut off; only after that does a run ask for a sign-in.

Nothing can be renewed after the session ends, since every renewal needs the session's token, and
role chaining (`AssumeRole` from role credentials) is capped at 1 hour, so it doesn't stretch
this either. Identity Center doesn't tell when its session ends, so the host only finds out when a
refresh is refused.

Settings, until the settings UI (roadmap 6) takes them over: the start URL, the SSO region, the
account and the role are user settings in the credential store, like `jira/url`:

```sh
echo 'https://example.awsapps.com/start' | mesh-flow credential set aws/start-url
echo 'eu-west-1' | mesh-flow credential set aws/sso-region
echo '123456789012' | mesh-flow credential set aws/account
echo 'Developer' | mesh-flow credential set aws/role
```

None of these are secrets. They go there only because it's the one settings store the engine has
today.

### 2. Signing in

Two ways to start the same flow, so both the "before I start" and the "it expired mid-run" cases
work:

- **Up front:** `mesh-flow login aws` prints the URL and code, waits for the approval, and stores
  the session.
- **From a run:** `aws.checkSession()` (below) finds no valid session, and the run waits for a
  sign-in. `mesh-flow list` shows `needs login: aws`, `mesh-flow show <run>` shows the URL and
  code. The engine polls `CreateToken` itself, so there's nothing to answer: the run goes on once
  the approval is in. Every run waiting on the AWS session waits on the same device authorization.

A run waiting for a sign-in is waiting on a human, like `input`: it doesn't count towards a loop's
`limit`, and it survives an engine restart (a new device authorization is started if the old one
expired meanwhile). This needs one new request kind in `@mesh-flow/protocol`, `login`, which the
engine answers instead of a human. The UI later turns it into a notification with a button.

### 3. `checkSession`

`aws.checkSession()` is a function for workflow code and a tool for agents (design section 8):

- the session is valid for longer than the renew threshold: returns at once;
- it can be refreshed without the user (refresh token): refreshes and returns;
- otherwise: waits for a sign-in as above.

The trigger doesn't refuse a run without a session (unlike a missing model provider), because
signing in is something the run can wait for. `deploy` and `trigger` do say when the AWS settings
themselves are missing, the same way they report missing host tools.

The registry shim calls it before the first fetch of a run, and again when a fetch is refused for
an expired token, so a long run whose session runs out asks once and goes on.

### 4. The registry shim (sandbox)

A read-only package feed inside the sandbox, served by the runtime, that turns each request into a
host tool call:

- **NuGet v3**: the service index, the flat container (version lists and `.nupkg` downloads) and the
  registration resources restore reads. **npm**: package documents and tarballs.
- One host tool, `codeArtifactFetch({ repository, format, path })`, which only accepts those read
  paths for the repositories the app declared, and sends the request to CodeArtifact with the
  authorization token. There is no write path, so the shim can't publish or delete.
- Answers are cached in the sandbox for the run, so a second restore doesn't cross again.
- Packages that aren't in CodeArtifact are its upstreams' job (nuget.org, npmjs) as CodeArtifact
  is normally set up; nothing in the shim decides that.

The app declares which repositories it restores from, next to the sandbox's egress, since it's
non-secret team config that belongs in git:

```ts
import { codeArtifact } from '@mesh-flow/aws'
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'

export default defineMeshFlow({
	sandbox: image({
		name: sandboxImage,
		memoryMb: 4096,
		egress: ['api.nuget.org'],
		registries: [codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })],
	}),
	workflows: [userTrigger(develop)],
})
```

## Open questions

1. **How the package manager finds the shim.** A real repository's `nuget.config` names
   CodeArtifact's own HTTPS URL, and NuGet has no setting that swaps a source's URL from outside.
   Options:
   - **a. Take over the hostname** (recommended): the sandbox resolves the declared CodeArtifact
     hostnames to the shim, which serves HTTPS with a CA made in the sandbox for that run and put
     in its trust store. The repository's config works unchanged and nothing can end up in a
     commit. The CA's key unlocks nothing outside the sandbox. microsandbox already intercepts TLS
     this way for its egress, so the trust store part is known to work there.
   - **b. Rewrite the source in the checkout** before restore (`dotnet nuget update source`, an
     `.npmrc` override). Simple, but the push tools commit every change, so it has to be undone
     before each push or kept out of git.
   - **c. A machine-wide config** that adds the shim as a source. NuGet merges configs and the
     repository's wins, so the CodeArtifact source still fails.
2. **Large packages over the mailbox.** Answers are whole JSON messages, base64 for bytes, like the
   git bundles. Fine for most packages; a package of hundreds of MB would sit in memory twice.
   Proposed: answers above a size go into a file the engine writes next to the inbox instead. Measure
   on the real repository first.
3. **Role credentials only work from the gateway** (`aws:SourceIp` in the design). Needs a role
   policy on your side; the shim works without it. Leave it to the account setup docs?
4. **Several AWS accounts** stay open question 9 of the design: one session per engine for now.

## Out of scope here

- Publishing to CodeArtifact (an upstream repository's packages, for dependent repositories).
- AWS operations as host tools beyond CodeArtifact.
- pip, Maven/Gradle, Go and Cargo, each with its own egress conformance test.
- The settings UI and how signing in looks there: designed with the UI (roadmap 6).
- Other ways to authenticate to AWS (access keys, IAM Roles Anywhere): IAM Identity Center only.

## Delivery

Stacked PRs, each on the previous one's branch:

1. `@mesh-flow/aws` host half: device flow, session in the credential store, `mesh-flow login aws`,
   role credentials and the CodeArtifact token. Tests against a fake SSO/OIDC endpoint; one manual
   check against your real Identity Center.
2. The `login` request: protocol, engine, `checkSession` as function and tool, `list`/`show`.
   Functional tests: a run that waits for a sign-in, across an engine restart, and shutdown while it
   waits.
3. The registry shim: `registries` in `image`, NuGet and npm feeds, `codeArtifactFetch`. Conformance
   test on gVisor and microsandbox against a fake CodeArtifact; then the real one by hand.
