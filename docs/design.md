# Design

Status: design converged (option C: plain async TypeScript). Validation spikes pending, see
[Open questions](#open-questions). Sketches of the reference workflow and packages live in
`examples/example/` and `packages/`; they haven't been type-checked yet.

## 1. Goal

Durable workflows that live in git instead of being clicked together in a UI. A workflow is a
deterministic TypeScript program that dispatches to AI agents where that makes sense. The
reference use case (`example`):

- collect a Jira story
- research it (agent), asking the user when unclear
- plan it (agent), with human approval, including a dependency graph between repositories
- per repository, in dependency order (1–10 repos, up to ~3 levels deep), concurrently where
  possible: check out, update packages from upstream, implement (agent), verify with tests,
  security checks and code review, open a merge request, handle pipeline failures and tagged
  review comments (agents) until merged, collect published packages for dependents
- keep Jira up to date along the way (In Progress → In Review → Done)

## 2. Design criteria

Every decision is tested against these:

1. **Reviewable in a diff.** Every change in flow is a visible change in code. No orchestrator
   prompt as the source of control flow.
2. **Readable as a story.** A workflow file reads top to bottom like the process it describes,
   without a framework vocabulary to learn first.
3. **Nothing faked.** No replay-based execution. Every `await` is real; the debugger shows the
   real stack.
4. **One building block, two callers.** A tool works when called from code and when handed to
   an agent.
5. **No credentials in the sandbox.** A compromised or prompt-injected agent can use what a run
   is allowed to use, for as long as the run uses it, but can't take a secret with it.

## 3. Architecture

```text
web UI (separate project)
   │  HTTP + SSE
host
   ├─ engine:  runs, sandbox lifecycle (create, snapshot, resume), input requests, notifications
   └─ gateway: the only egress for credentials (models, AWS, package registries, git, Jira, GitLab)
   │  run token
sandbox per run (E2B: Embed locally, cloud later)
   ├─ workflow runtime (plain async TS, events via AsyncLocalStorage)
   ├─ agents: Pi Durable underneath `loop`
   └─ repository checkouts, toolchains, tests
```

- **One sandbox per run**, so runs can't contaminate each other. Workflow code, agent calls and
  checkouts all run inside it.
- **The engine** never runs workflow code. It starts, snapshots and resumes sandboxes, relays
  human input and external events (webhooks), and serves the UI API. The prototype's
  `WorkflowRuntime` seam (`dispatch() → events`, `submitInput()`) is the host↔sandbox protocol.
- **The gateway** holds every credential and is the only way out for anything that needs one.
  The sandbox's network is locked down to the gateway and public package sources.

## 4. Authoring model

A workflow is an async function. The whole vocabulary is in `packages/core/src/index.d.ts`.

```ts
export default workflow('develop', async () => {
    const { key } = await input('Which story should be developed?', { key: jira.key });
    const story = await jira.collect(key);

    const research = await planner.loop`
        Research ${story}. Find related issues with ${jira.search} and read them with ${jira.dump}.
        Write your findings as Markdown in ${Research}, then ${succeed(Research)}.
    `;

    const plan = await planner.loop`
        Create a development plan for ${story}, based on ${research}.
        Write it to plan.md, then propose it with ${propose(Plan)}.
        When the proposal is rejected, revise the plan with the feedback and propose it again.
    `;

    await inDependencyOrder(deliveryOrder(plan), async (part, upstream) => {
        // checkout, implement with ${verify(...)}, merge request, review, publish ...
    });
});
```

### Agents

```ts
export const planner = agent({
    model: 'claude-opus-5-5',          // a model id, resolved by the gateway (section 7)
    reasoning: 'high',
    system: prompt`... When anything is unclear, ${requestUserInput} instead of guessing.`,
});
```

- Agents are defined in the workflow repo (`agents.ts`): models and conventions are team
  specific. Packages take agents as parameters.
- `system` is a tagged template like `loop`: tools interpolated there are available in every loop
  of that agent.
- `agent.as(name, { in, verify })` turns an agent into a tool for another agent, with its own
  gate (e.g. a reviewer asking a developer for a change that must pass tests).

### `loop` and interpolation

`agent.loop\`...\`` runs the agent (a Pi Durable session keyed by call site) until it calls an
exit tool. What an interpolated value becomes:

| Value | In the prompt |
|---|---|
| a tool | registered for this loop, referenced by name |
| an exit (`succeed`, `propose`, `verify`, `fail`) | registered as an exit tool, referenced by name |
| a workspace file | its path |
| a workspace folder | its path plus a listing of its files |
| anything else | rendered as text |

### Exit tools: gates on "may this agent finish?"

| Exit | Who decides | On rejection |
|---|---|---|
| `succeed(schema?)` | the schema (or nothing) | validation error back to the agent |
| `succeed(folder)` | the folder's constraints (e.g. `minFiles`) | error back to the agent |
| `propose(schema)` | a human | feedback back to the agent; the run waits while pending |
| `verify(...checks)` | code: checks run concurrently when the agent hands in | findings back to the agent; fails after `maxRejections` (default 5) |
| `fail` | the agent gives up | `loop` rejects with the reason |

- `loop`'s result type is inferred from the exits among the interpolated values; without exits
  it's the agent's final text.
- If the model stops without calling a present exit, the engine nudges it, up to a maximum.
- Exits combine, e.g. `verify` before `propose`.

### Building blocks

Packages export three kinds of things, and nothing else:

- **Functions** for code: `jira.collect`, `gitlab.openMergeRequest`, `dotnet.updatePackages`.
- **Tools** for agents: `jira.search`, `gitlab.searchRepositories`, `gitlab.push(repository)`.
  Every tool is also callable as a function.
- **Checks** for `verify`: `dotnet.tests(repository)`, `codeReview(reviewer, repository, plan)`,
  `gitlab.pipelinePasses(mergeRequest)`. Lazy: they run when `verify` asks. A check may wait on
  something external (a pipeline).

Primitives that create things are idempotent (reuse an existing checkout, branch, merge request,
status or identical comment).

### Other primitives

- `input(question, fields)`: asks a human for typed input; the run waits.
- `requestUserInput`: tool that lets an agent ask the user mid-loop.
- `inDependencyOrder(nodes, deliver)`: runs `deliver` per node as soon as its dependencies have
  returned, passes their results as `upstream`, runs independent nodes concurrently. Fails up
  front on cycles or unknown ids; a failed node blocks only its dependents.
- `workspace.file(path)`, `workspace.folder(path, options)`: run workspace in the sandbox.
- `<connector>.checkSession()`: see section 8.

### Plan deviations (preset pattern)

The approved `plan.md` is never rewritten. Later findings (review comments, a repository that
turns out differently) are recorded with a `recordDeviation` tool in `plan-deviations.md`, and
every later task prompt reads both. Repositories delivered later in the dependency order thereby
pick up deviations found earlier.

## 5. Durability

- **Every `await` is real.** While a run waits for a human or an external event, the engine
  snapshots the sandbox (E2B pause keeps memory and processes) and stops it. The answer resumes
  it, and the await resolves in the same stack. The snapshot also pins the code version per run.
- **Design rule: no open connections across a wait.** Primitives open connections per call.
- **Agents** are Pi Durable sessions, so a conversation and its pending tool calls survive a
  crash independently of the snapshot.
- **Fallback** (lost snapshot, crash, E2B falling back to a filesystem-only pause): the run
  restarts from the top. Idempotent primitives and Pi Durable sessions keyed by call site make
  the rerun cheap. Where that's still too expensive, an explicit, opt-in `checkpoint(name, fn)`
  can be added (open question 6). The UI shows "run restarted".

## 6. Failure and cancellation

- A thrown error fails the run; the UI offers a restart.
- `verify` fails the loop after `maxRejections`, with the last findings.
- `inDependencyOrder`: a failed node blocks its dependents; independent nodes continue; the result
  reports failed nodes explicitly.
- Cancellation: `AbortSignal` everywhere, passed implicitly via `AsyncLocalStorage`. Cancellation
  stops work; it does not clean up branches or merge requests.

## 7. Credentials and the gateway

The sandbox gets a **run token**, valid for that run only, revoked when it ends. The gateway
turns it into access in one of three ways:

| Mechanism | Used for |
|---|---|
| **Credential-injecting reverse proxy**, per provider, native API (no translation) | model providers, package registries (CodeArtifact NuGet/npm), Jira and GitLab APIs |
| **Short-lived handout** through a standard endpoint | AWS via `AWS_CONTAINER_CREDENTIALS_FULL_URI` (HTTPS or a loopback forwarder); `credential_process` for tools that need a file |
| **Credential helper** asking the gateway per operation | git |

### Model providers

- Agents name a **model id**. The gateway resolves it model-first: the first provider in the
  user's ordered list that offers it.
- Agents are module-level, so the engine knows a workflow's models before a run starts and checks
  them against the user's providers up front.
- In the sandbox, pi-ai uses each provider's native API with `baseUrl` pointing at the gateway,
  which keeps provider-specific features (thinking, caching, headers) intact.
- Usage and cost per run are measured at the gateway.

### AWS

- **Host session:** IAM Identity Center via device flow, started from the UI. The gateway holds
  the access and refresh tokens. Nothing outlives the session maximum set by the Identity Center
  admin.
- **Per run:** the gateway fetches role credentials (`GetRoleCredentials`) for the configured
  account and permission set, refreshes them while the run is active and refreshing needs no
  interaction, and adds `aws:SourceIp` so they only work from the gateway's egress.
- **Lazy login:** when a run needs AWS and the session is missing, expired or within the renew
  threshold, the run raises an input request with a notification. One login resumes every run
  waiting on it. When a session is close to expiring while runs use it, the user is warned ahead
  of time.
- Use a separate AWS account for test runs, a permissions boundary on the role, and CloudTrail
  with the run id as session name.
- CodeArtifact tokens are fetched by the gateway with the same session.

## 8. Connectors

A connector has a settings schema, a gateway half and a sandbox half:

```ts
export const aws = connector({
    id: 'aws',
    settings: z.object({
        startUrl: z.string().url(),
        region: z.string(),
        account: z.string(),
        permissionSet: z.string(),
        renewThreshold: z.string().default('2h'),
    }),
    gateway: { login, refresh, expiresAt, issue },   // auth, refresh, handing out credentials
    sandbox: { prepare },                             // points tools at the gateway
});
```

- Every connector with a session gets `checkSession()` automatically, as a function and as a
  tool: returns immediately when the session is valid beyond the threshold, refreshes when
  possible, otherwise raises an input request and waits. An agent that hits expired credentials
  can call it itself.
- Workflows import the connectors they use, so the engine knows each workflow's requirements.

## 9. Settings

| Where | What |
|---|---|
| **Git** (workflow repo) | workflows, agents (model ids), static non-secret team config (start URLs, regions, accounts, thresholds) |
| **UI** (per user) | providers and their order, credentials, logins, overrides of static config |
| **Host config** | infrastructure only: gateway URL, credential store, KMS key |

- Credentials are stored server-side, encrypted per user (envelope encryption); locally in the OS
  keychain or an encrypted file. Same code path.
- Startup fails only on infrastructure. Missing user settings never block startup.
- Starting a run checks that workflow's requirements and shows a wizard with only what's missing.
- During a run, a revoked token or failed refresh becomes an input request ("reconnect X"), not
  a failure.
- Model credentials should come from a list of owners (user, later team) so team-level providers
  fit later without a storage rebuild.

## 10. UI contract

- An **event tree**: every primitive, tool call and `loop` emits events with `id` and `parentId`
  (via `AsyncLocalStorage`). There is no static graph; the tree is appended as the run proceeds.
- **Multiple pending human requests** per run, keyed by request id (two repositories can ask at
  once). Credential requests are shared across runs.
- Status roll-up: "needs input" bubbles to the top.
- Natural views: `inDependencyOrder` → lanes/DAG, review handling → event feed (one row per
  triaged comment), `verify` → attempts with findings.
- Usage and cost per run from the gateway.

## 11. Reuse from the earlier prototype

Carries over: the `atlassian`, `git`, `gitlab` and `model-providers` packages (the latter becomes
the gateway's provider implementation, fed from the credential store instead of `.env`); the
abort-signal discipline and hang tests; the `WorkflowRuntime` seam as host↔sandbox protocol;
the Run aggregate and control-plane API; the proven Pi Durable review loop.

Needs to change: workflow definitions become plain async functions; flat step events become an
event tree; a single `Run.pending` becomes a list keyed by request id; the per-ticket workspace
becomes a sandbox per run; `ticketId` and Jira/GitLab-specific artifacts leave the core;
`.env`-based provider config moves to the UI and credential store.

## Open questions

1. **E2B spike (blocking).** Does pause/resume with memory work in E2B Embed? Is `/dev/kvm`
   available on the dev machine (NixOS on WSL2 needs nested virtualization), or does Embed run on
   a separate Linux box?
2. **Typing spike.** Infer `loop`'s result type from the exits in a tagged template's values,
   including `succeed(folder)`, `propose`, `verify` and no exit at all. Types only.
3. **The plan as file plus data.** `workspace.file('plan.md', { schema: Plan })`: renders as the
   file in prompts, gives code the validated data (repositories, dependency graph).
4. **Checks and the agent's latest output.** Checks run when the agent hands in; does a check ever
   need what the agent handed in?
5. **`inDependencyOrder` failure semantics** as tests: dependents blocked, independents continue,
   partial results reported.
6. **Opt-in `checkpoint()`** for expensive non-agent work, if reruns after a lost snapshot turn out
   too costly.
7. **Merge request watching** (GitLab connector, on the engine's durable external-event primitive):
   serialize handlers per merge request, drop events for superseded commits, coalesce one review
   round.
8. **Hosted OAuth.** CLI-style OAuth with a localhost callback doesn't work hosted; prefer device
   flows, register own OAuth apps otherwise. Check provider terms before offering subscription
   logins (as opposed to API keys).
9. **Several instances of one connector** (e.g. two AWS accounts): named instances in config, picked
   by name in the workflow. Only when needed.
10. **Embed's idle cost on a dev machine.** Idle with no sandboxes, Embed takes about a quarter of
    a core (mostly ClickHouse) and 1+ GB RAM, with peaks over one core
    ([findings](../pocs/e2b-pause/README.md#findings)). Paused sandboxes survive an Embed
    restart, so the engine could start Embed when a run needs a sandbox and stop it once every run
    is paused or done (a warm start took about 70 s). Alternatives: trim Embed (ClickHouse is only
    for logs and metrics), or use E2B cloud for development and self-host only on a server.
    Whatever starts Embed also stops it: on the engine's own shutdown it pauses running sandboxes
    and stops Embed cleanly, and it recovers from an unclean stop on the next start, so nothing
    depends on a user stopping Docker first.

Out of scope for now: token and cost budgets.

## Roadmap

1. Spikes: E2B pause, `loop` result typing (2–4 days).
2. MVP: workflow runtime with events, `loop` with exits on Pi Durable, `input`, gateway for model
   providers, a sandbox per run kept alive while waiting (no snapshots yet), the `example`
   workflow end to end from a CLI with sequential repositories.
3. Snapshots on wait (engine-side only; workflow code doesn't change).
4. `inDependencyOrder` with concurrency.
5. GitLab review watching; AWS and CodeArtifact through the gateway; `checkSession`.
6. UI, settings wizard, credential store.
7. Hosted, multi-user.

## Glossary

- **Run**: one execution of a workflow, in its own sandbox.
- **Gateway**: the host service that holds credentials and is the only egress needing them.
- **Run token**: the sandbox's only credential; valid for one run.
- **Exit tool**: `succeed`, `propose`, `verify` or `fail`, interpolated in a prompt; the only way
  an agent finishes.
- **Check**: a lazy verification used by `verify`.
- **Connector**: package with settings, a gateway half and a sandbox half (Jira, GitLab, AWS, …).
