# Plan: AWS sign-in and CodeArtifact restores

Status: agreed 2026-11-16; delivery steps 1 (no direct egress), 2 (the AWS host half) and 3 (the
`login` request) built, step 4 not. Covers the first part of roadmap step 5 of
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

1. `RegisterClient` at each sign-in. The registration lasts about 90 days, so it always outlasts
   the session, whose refresh token only works with the client it was handed to.
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
- **From a run, when it's needed:** any host tool that needs AWS, such as `codeArtifact.fetch`,
  finds no valid session and the run waits for a sign-in right there, in front of the call. Nothing
  has to call `checkSession` first. `mesh-flow list` shows `needs login: aws`, `mesh-flow show <run>`
  shows the URL and code. The engine polls `CreateToken` itself, so there's nothing to answer: the
  call goes on once the approval is in. Every run waiting on the AWS session waits on the same
  device authorization.

A run waiting for a sign-in is waiting on a human, like `input`: it doesn't count towards a loop's
`limit`, and it survives an engine restart (a new device authorization is started if the old one
expired meanwhile). This needs one new request kind in `@mesh-flow/protocol`, `login`, which the
engine answers instead of a human. The UI later turns it into a notification with a button.

### 3. `checkSession`

Signing in is reactive (Marvin, 2026-11-16): the AWS host tools answer "needs a session" instead
of failing, and their stub in the sandbox raises the `login` request, waits, and calls again. So a
`dotnet restore` that hits CodeArtifact without a session just takes longer, and the same holds for
a token that expires during a long run. A host call itself is never held open while the user signs
in, so an engine restart in the middle is a plain resumed wait.

`aws.checkSession()` stays as a function and a tool (design section 8) for code that wants to ask
up front, such as before a long unattended stretch, but nothing needs it.

The trigger doesn't refuse a run without a session (unlike a missing model provider), because
signing in is something the run can wait for. `deploy` and `trigger` do say when the AWS settings
themselves are missing, the same way they report missing host tools.

### 4. The registry shim (sandbox)

The sandbox gets no direct egress at all (Marvin, 2026-11-16): every package fetch, from
CodeArtifact and from public registries alike, is a tool call to the host. That supersedes "public
package sources stay reachable directly" in the [gateway plan](gateway-tool-calls.md) and the
`egress` hosts of PR #26; the sandbox runs without a network on every backend.

- **Fetches are tool calls**, so code and a user can make them too, not only a package manager:
  `codeArtifact.fetch({ repository, format, path })` with the CodeArtifact token on the host, and
  `fetchPackage({ registry, path }, abortSignal)` from `@mesh-flow/core` for the public registries
  the app allows (nuget.org, npmjs), without a credential. Both only accept the read paths of the
  format: for **NuGet v3** the service index, the flat container (version lists and `.nupkg`
  downloads) and the registration resources restore reads; for **npm** package documents and
  tarballs. There is no write path, so nothing can publish or delete through them.
- **The package manager reaches them through a proxy in the sandbox.** The sandbox's `HTTPS_PROXY`
  points at a proxy served by the runtime (built in delivery step 1). Package managers keep their
  config: a repository's `nuget.config` that names CodeArtifact's own URL works unchanged, nothing
  has to be rewritten in a checkout, and nothing can end up in a commit. The proxy terminates TLS
  with a CA made in the sandbox for that run and put in its trust store (and `NODE_EXTRA_CA_CERTS`
  for npm); the CA's key unlocks nothing outside the sandbox. It answers each request it recognizes
  with the matching tool call and refuses everything else, so there's no way out but the tools.
- **Package bytes are staged, not sent back.** Delivery step 1 still sends them back, base64 in
  the call's answer, up to 256 MB a fetch (`maxPackageBytes` in `@mesh-flow/gateway`), on the
  run's endpoint, whose four tokens model and tool calls share; staging also takes package fetches
  off those tokens. The engine writes each fetched package as a file
  into the sandbox (`mailbox/packages/`) and the tool's answer only names it, so the mailbox carries
  small JSON and a 100 MB nupkg is never base64 in memory. The engine already reaches the sandbox
  only by writing files and running commands in it, so this is ingress only: the sandbox never
  opens a connection to anything, not even to the host.
- **Packages are cached on the host**, shared by every run, by registry, package and version.
  Published versions don't change, so a cached one is always right; version lists and metadata
  are fetched again. A warm restore then only waits on the mailbox, not on the registry.
- Whether a package comes from CodeArtifact or its upstreams (nuget.org, npmjs) stays
  CodeArtifact's setup, as the repository's config names it.

The app declares where it restores from, since it's non-secret team config that belongs in git.
`registries` takes a registry's name today; delivery step 3 widens it to take a CodeArtifact
repository as well:

```ts
import { codeArtifact } from '@mesh-flow/aws'
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'

export default defineMeshFlow({
	sandbox: image({
		name: sandboxImage,
		memoryMb: 4096,
		registries: [
			'nuget',
			codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' }),
		],
	}),
	workflows: [userTrigger(develop)],
})
```

## Settled (Marvin, 2026-11-16)

1. **No network on any backend** (built in delivery step 1). microsandbox and E2B get no egress
   rules at all, the `egress` option is gone, and so is gVisor's egress forwarder: the runtime's
   proxy replaces it. The package egress conformance tests of PR #26 became a check that there is
   no network but loopback, and a restore through the proxy on each real backend.
2. **The mailbox stays the channel.** It is the one channel that works the same on all three
   backends without a network, and it's ingress only. A socket from the sandbox to the host would
   need a network rule on microsandbox (unverified, design open question 11) and E2B. Its delay is
   the runtime looking for answers every 250 ms (`answerPollMs` in `@mesh-flow/protocol`); that
   can go down, or watch the inbox, if restores are slow. Measure on the real repository.
3. **No `aws:SourceIp` condition.** Credentials never leave the host, so it would add little and
   break on a changing home IP.
4. **Signing in is reactive**, from the tool that needs AWS (section 3).
5. **AWS settings in the credential store** until the settings UI.
6. **One AWS account per engine.** Several: issue #39.
7. **Token lifetimes:** the CodeArtifact token is refreshed with the role credentials it was
   fetched with, so one refresh covers both.

## Out of scope here

- Publishing to CodeArtifact (an upstream repository's packages, for dependent repositories).
- AWS operations as host tools beyond CodeArtifact.
- pip, Maven/Gradle, Go and Cargo, each with its own conformance test through the proxy.
- The settings UI and how signing in looks there: designed with the UI (roadmap 6).
- Other ways to authenticate to AWS (access keys, IAM Roles Anywhere): IAM Identity Center only.

## Delivery

Stacked PRs, each on the previous one's branch:

1. No direct egress (built): the runtime's proxy with its sandbox CA, `fetchPackage` for nuget.org
   and npmjs, `registries` in `image` replacing `egress`, no network on every backend. Tests: npm
   and curl (OpenSSL's trust, as .NET's) through the proxy on the host, other hosts and writes
   refused, a run's commands finding the proxy in their environment; the backends' conformance
   suite checks there is no network but loopback, and the engine's real-backend CI jobs run
   `npm install` through the proxy in a gVisor and a microsandbox sandbox. `dotnet restore` runs
   through the proxy on the Linux CI host, which has the SDK; inside a real backend it waits for an
   image with Node and the .NET SDK (inline Dockerfiles, issue #36).
2. `@mesh-flow/aws` host half (built): device flow, session in the credential store,
   `mesh-flow login aws`, role credentials and the CodeArtifact token. Tests against a fake
   SSO/OIDC endpoint; one manual check against your real Identity Center.
3. The `login` request (built): protocol, engine, `checkSession` as function and tool,
   `list`/`show`. Functional tests: a run that waits for a sign-in, across an engine restart, and
   shutdown while it waits. As built: a host tool throws `SignInNeededError` (from
   `@mesh-flow/gateway`) and its answer names the connector; the runtime's gateway client asks for
   the `login` and calls again, sharing one request per connector. The engine keeps one sign-in per
   connector for every waiting run, starts a new code when one runs out, and `mesh-flow login` joins
   it while the engine serves. Connectors get only their own credentials (`<connector>/...`),
   writable, for their tools and their sign-in. A resumed run starts a new device authorization.
   Still open for step 4: `deploy` and `trigger` saying when the AWS settings are missing.
4. `codeArtifact.fetch` behind the proxy, with the host cache and staged files. Conformance test
   against a fake CodeArtifact; then the real one by hand.
