# Design

Status: design converged (option C: plain async TypeScript). The sandbox and typing spikes are
done; the MVP build plan is in [`plans/mvp-build.md`](plans/mvp-build.md). Sketches of the
reference workflow and packages live in `examples/example/` and `packages/`; they haven't been
type-checked yet.

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
   └─ gateway: runs credentialed tools and holds every credential (models, AWS, git, Jira, GitLab)
   │  tool calls (endpoint + token per loop)
sandbox per run (hosted: E2B; local: microsandbox, or gVisor without a hypervisor)
   ├─ workflow runtime (plain async TS, events via AsyncLocalStorage)
   ├─ agents: Pi Durable underneath `loop`
   └─ repository checkouts, toolchains, tests
```

- **One sandbox per run**, so runs can't contaminate each other. Workflow code, agent calls and
  checkouts all run inside it.
- **Sandbox backends** sit behind one engine interface (create, pause to disk, resume, egress
  policy) and all pass the same checks ([`pocs/pause-harness`](../pocs/pause-harness/README.md)):
  - **hosted: E2B Cloud**;
  - **local: microsandbox** (microVMs from an npm package, no daemon) when a hypervisor is usable:
    `/dev/kvm` on Linux and WSL, Hypervisor.framework on macOS, the Windows Hypervisor Platform on
    Windows;
  - **local without a hypervisor: gVisor** (`runsc`, Linux only, needs root), for example in a cloud
    container or CI.

  The engine picks the local backend at startup ([`pocs/sandbox-pause`](../pocs/sandbox-pause/README.md)
  shows the rule). Snapshots don't move between backends or machines: a paused run resumes where it
  was paused.
- **The engine** never runs workflow code. It starts, snapshots and resumes sandboxes, starts runs
  from triggers (buttons, webhooks, schedules; section 4), relays human input and external events
  to running runs, and serves the UI API. What a workflow repository declares (workflows, their
  parameters, triggers, agents and connectors) it learns by running the entry file in a sandbox in
  describe mode ([Triggers](#triggers)). The prototype's
  `WorkflowRuntime` seam (`dispatch() → events`, `submitInput()`) is the host↔sandbox protocol,
  carried by a mailbox in the sandbox: the runtime appends messages to an outbox, the engine
  long-polls it and writes answers to an inbox, all through the sandbox interface's `exec` and
  `writeFile` ([engine README](../packages/engine/README.md#the-mailbox)).
- **The gateway** holds every credential and runs every tool that needs one. The sandbox calls
  those tools over the host↔sandbox channel; it sends no credentialed traffic itself. Its network
  is locked down to the gateway and public package sources.

## 4. Authoring model

A workflow is an async function. The whole vocabulary is exported from
`packages/core/src/_module/core.mts`. What a run starts with is the workflow's parameters; how a
run gets started is in the entry file ([Triggers](#triggers)).

```ts
export const develop = workflow('develop', { key: jira.key }, async ({ parameters }) => {
    const story = await jira.collect(parameters.key);

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

- Agents are defined in the workflow repo (`agents.mts`): models and conventions are team
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
| `limit(...)` | the loop's limit, as a line the agent can read (see [Loop limits](#loop-limits)) |
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

### Loop limits

A loop can be limited as a whole, with one interpolated line at the end of the template, next to
the exits:

```ts
const description = await planner.loop`
    Write a short merge request description for the changes in ${repository},
    based on ${plan.path}. ${succeed(gitlab.Description)}
    ${limit({ turns: 4, minutes: 20 })}
`;
```

- **Loop-wide only.** There are no limits per tool: a tool doesn't know how often it's reasonable
  to call it in a given task, the loop does.
- `turns` counts model turns. `minutes` counts the agent's own runtime, tracked by the engine; time
  spent waiting on a human (`propose`, `requestUserInput`, a login) doesn't count.
- The line renders as text, so the agent knows its budget and can plan for it.
- Without a `limit`, a loop is unconstrained.
- Exceeding a limit rejects the loop, like any other error (section 6).
- `verify`'s `maxRejections` and the cap on missing-exit nudges are separate and keep their own
  defaults.

### Context

There is **no context compaction**. Workflows are shaped so a loop's context never needs it:

- **One loop per task.** A workflow runs a new loop for each piece of work instead of one long
  conversation (review handling is one loop per comment round, not one loop per merge request).
- **Results pass as values and files**, not as chat history: a loop's result is data the next
  loop gets interpolated, and big things are `workspace.file` or `workspace.folder` paths the
  agent reads when it needs them.
- **Values control their own rendering.** An interpolated value decides how much of itself ends
  up in the prompt (a story renders as the path of its Markdown dump, a folder as its path plus a listing).
- **Tools cap their own output.** A tool that can produce a lot (test runs, logs, search) writes
  the full output to a file in the workspace and returns a summary plus the path. That is part of
  the tool, not an engine feature.

Hitting the model's context limit fails the loop. That is a bug in the workflow or a tool, and it
shows up as one instead of as silently dropped context.

### Pre-fetching

A convention, not a feature: when an agent would call a tool in nearly every run, call it in code
and interpolate the result instead. It saves a model turn and makes the input visible in the diff.
This works because a tool is also a function:

```ts
const related = await jira.search({ jql: `text ~ "${story.summary}"` });
const research = await planner.loop`
    Research ${story}. These issues look related: ${related}. Read them with ${jira.dump}.
    ...
`;
```

### Building blocks

Packages export three kinds of things, and nothing else:

- **Functions** for code: `jira.collect`, `gitlab.openMergeRequest`, `dotnet.updatePackages`.
- **Tools** for agents: `jira.search`, `gitlab.searchRepositories`, `gitlab.push(repository)`.
  Every tool is also callable as a function. A tool validates its own arguments, retries its own
  transient failures and caps its own output ([Context](#context)).
- **Checks** for `verify`: `dotnet.tests(repository)`, `codeReview(reviewer, repository, plan)`,
  `gitlab.pipelinePasses(mergeRequest)`. Lazy: they run when `verify` asks. A check may wait on
  something external (a pipeline).

Primitives that create things are idempotent (reuse an existing checkout, branch, merge request,
status or identical comment).

### Other primitives

- `workflow(name, body)`, `workflow(name, parameters, body)`: defines a workflow. `parameters` is
  a zod shape for what a run starts with. The body gets one context object with the parsed
  `parameters` and the run's `abortSignal`. How a workflow gets started is not part of it (see
  [Triggers](#triggers)).
- `input(question, fields)`: asks a human for typed input; the run waits. This works in any run,
  whatever started it: a run started by a webhook or a schedule waits for a human the same way.
- `requestUserInput`: tool that lets an agent ask the user mid-loop.
- `limit({ turns?, minutes? })`: a loop-wide limit, interpolated in the template.
- `inDependencyOrder(nodes, deliver)`: runs `deliver` per node as soon as its dependencies have
  returned, passes their results as `upstream`, runs independent nodes concurrently. Fails up
  front on cycles or unknown ids; a failed node blocks only its dependents.
- `workspace.file(path)`, `workspace.folder(path, options)`: run workspace in the sandbox.
- `<connector>.checkSession()`: see section 8.

### Triggers

A workflow says what it does and what it starts with, never how it is started. One entry file in
the workflow repository, `workflows/main.mts`, lists everything that can start a run, so there is
one place to see what is live:

```ts
// workflows/fix-issue.mts
export const fixIssue = workflow('fix-issue', { issue: z.number() }, async ({ parameters, abortSignal }) => {
	const issue = await github.collect(parameters.issue)
	// ...
})

// workflows/main.mts
export default defineWorkflows(
	userTrigger(fixIssue),
	webhook(fixIssue, github.issueLabeled('ai-fix').transform((event) => ({ issue: event.issue.number }))),
	schedule(weeklyReport, '0 7 * * 1'),
)
```

- **Triggers take the workflow itself, not its name,** so TypeScript checks that a trigger gives
  the workflow the parameters it needs. One workflow can have several triggers.
- **`userTrigger(workflow)`** is a button in the UI. The workflow's parameters become the button's
  form, filled in before the run starts, so a run doesn't start before it has what it needs. A
  workflow without parameters gets a plain button.
- **`webhook(workflow, schema)`** starts a run for each delivery that fits a zod schema. The
  schema's output type has to be the workflow's parameters, so a mapping is a `.transform` on the
  schema, not a separate function. Connectors export schemas for their providers' events
  (`github.issueLabeled(label)`) together with how the provider signs a delivery; any zod schema
  works too, with a shared-secret header. The signing secret is set in the UI and checked by the
  engine before anything else, so the sandbox never sees it. The delivery id is the run's key: a
  redelivery reuses the run it already started.
- **`schedule(workflow, cron, parameters?)`** starts a run on the engine's wall clock (timed waits
  are engine-side, section 5). The parameters are fixed values, checked against the workflow's
  shape at compile time. A tick is skipped while the previous run of that schedule is still going.
- **Only workflows listed in the entry file can be started by the UI, a webhook or a schedule.**
  The CLI and tests (`runWorkflow`) can still start any workflow the entry file's modules export.
- **Nothing in the entry file is a setting.** Webhook secrets, enabling or pausing a trigger, and
  overrides are user settings in the UI (section 9). The entry file only says that a workflow *can*
  be started a certain way; the schema and the button work as soon as it is committed.
- **The engine never runs the entry file on the host.** It runs it once per commit in a sandbox in
  describe mode: `defineWorkflows` sends the workflows, their parameters as JSON Schema and their
  triggers over the mailbox and exits. The engine caches that per commit. A run then starts the
  entry file with the name of the workflow to run.
- **A webhook trigger starts a run; an external event wakes one.** Events a running run waits for
  (review comments in `github.review`) arrive through the same ingress and signature check, but
  go to the run that waits for them, not to a trigger.
- **Webhook payloads are checked in two steps.** The engine checks a delivery's signature and the
  input side of the schema as JSON Schema (structure, literals, enums) before it creates a sandbox,
  so an unrelated event never costs a run: it gets a 4xx. `.refine` and `.transform` are code, so
  they run in the sandbox when the run starts; a payload they reject ends the run as *not for this
  workflow*, which isn't a failure. Filters belong in the schema's structure where they can
  (`label: z.object({ name: z.literal('ai-fix') })`), which is what `github.issueLabeled(label)`
  does.

### Plan deviations (preset pattern)

The approved `plan.md` is never rewritten. Later findings (review comments, a repository that
turns out differently) are recorded with a `recordDeviation` tool in `plan-deviations.md`, and
every later task prompt reads both. Repositories delivered later in the dependency order thereby
pick up deviations found earlier.

## 5. Durability

- **Every `await` is real.** While a run waits for a human or an external event, the engine
  snapshots the sandbox (every backend keeps memory and processes) and stops it. The answer resumes
  it, and the await resolves in the same stack. The snapshot also pins the code version per run.
- **Design rule: no open connections across a wait.** Primitives open connections per call.
  A pause drops open connections: an HTTP stream into an E2B sandbox ended within 0.4 s of the
  pause ([e2b-pause](../pocs/e2b-pause/README.md#findings)).
- **Design rule: the engine leaves nothing running when it exits.** On shutdown (a signal, a
  fatal error, a normal exit) the engine aborts its work, pauses every running sandbox to disk,
  flushes its own state and closes every backend process it started. A local backend never
  depends on the user stopping it (or Docker) first. Because a process can also die without
  warning (`SIGKILL`, power loss), every start begins by reconciling: sandboxes the engine has no
  record of are removed, runs whose sandbox is gone are marked for restart (the fallback below).
- **Design rule: timed waits are engine-side.** Across a pause, E2B stops the guest's monotonic
  clock and gVisor doesn't, so a `setTimeout` inside the sandbox behaves differently per backend.
  Deadlines and "wait until" are engine-side wake-ups, like any external event. `Date.now()` is
  correct after a resume on every backend.
- **Agents** are Pi Durable sessions, so a conversation and its pending tool calls survive a
  crash independently of the snapshot.
- **Fallback** (lost snapshot, crash, a backend falling back to a filesystem-only pause): the run
  restarts from the top. Idempotent primitives and Pi Durable sessions keyed by call site make
  the rerun cheap. Where that's still too expensive, an explicit, opt-in `checkpoint(name, fn)`
  can be added (open question 6). The UI shows "run restarted".

## 6. Failure and cancellation

- **Errors bail by default.** Any error thrown inside a loop (by a tool, a check, the model
  provider or the engine) rejects the `loop` call. Unless the workflow catches it, it fails the
  run; the UI offers a restart. The engine doesn't retry and doesn't hand thrown errors back to the
  agent. A tool that wants the agent to see a failure (a bad argument, nothing found) returns that
  as its result, and transient failures are retried inside the tool.
- **Protocol, not errors:** exit-schema validation errors and `verify` findings go back to the
  agent, as described in section 4. Neither throws until its cap (`maxRejections`, the nudge cap).
- `verify` fails the loop after `maxRejections`, with the last findings.
- Exceeding a loop's `limit` rejects the loop with which limit was hit.
- Hitting the model's context limit rejects the loop.
- `inDependencyOrder`: a failed node blocks its dependents; independent nodes continue; the result
  reports failed nodes explicitly.
- Cancellation: `AbortSignal` everywhere, passed implicitly via `AsyncLocalStorage`. Cancellation
  stops work; it does not clean up branches or merge requests.

## 7. Credentials and the gateway

No credential ever enters the sandbox. Full rules in
[gateway-tool-calls.md](plans/gateway-tool-calls.md).

| Mechanism | Used for |
|---|---|
| **Host-side tools** called over the host↔sandbox channel (JSON-RPC) | everything that needs a credential: Jira, GitLab, GitHub, AWS operations; git clone/fetch/push as functions for workflow code only |
| **Model calls** over the same channel, native request and response passed through | model providers |
| **Registry shim** in the sandbox turning package fetches into read-only tool calls | private package registries (CodeArtifact NuGet/npm) |

### Tool calls

- **Where a tool runs is part of the tool.** Tools without credentials (shell, files, tests) run in
  the sandbox. Credentialed tools run on the host; the sandbox has a stub with the same signature.
  A tool's own code is the limit on what its credential can do: there's no raw HTTP to the API
  for the agent to misuse.
- **An endpoint and token per loop.** When a `loop` starts, the runtime registers the tools
  interpolated into its template and gets an endpoint and token for that loop only. Calls outside
  that set are refused, failing closed with a clear error. Each token is single-use and the
  response carries the next, so a stolen one is detected (the runtime's own call fails and the
  loop fails). Revoked when the loop settles. Workflow
  code gets a run-level endpoint for the tools the workflow imports, revoked when the run ends.
- **Tokens stay out of the agent's reach:** only in the runtime's memory, and agent shell commands
  run as a separate unprivileged user, so concurrent loops can't use each other's endpoints.
- **Validated on the host** against the tool's schema before it runs. Aborts propagate both ways.

### Model providers

- Agents name a **model id**. The gateway resolves it model-first: the first provider in the
  user's ordered list that offers it.
- Agents are module-level, so the describe run ([Triggers](#triggers)) tells the engine a
  workflow's models before a run starts, and it checks them against the user's providers up front.
- In the sandbox, pi-ai sends each provider's native request over the channel and the gateway
  forwards it with the credential, which keeps provider-specific features (thinking, caching, headers) intact.
- Usage and cost per run are measured at the gateway.

### AWS

- **Host session:** IAM Identity Center via device flow, started from the UI. The gateway holds
  the access and refresh tokens. Nothing outlives the session maximum set by the Identity Center
  admin.
- **Per run:** the gateway fetches role credentials (`GetRoleCredentials`) for the configured
  account and permission set, refreshes them while the run is active and refreshing needs no
  interaction, and adds `aws:SourceIp` so they only work from the gateway's egress. AWS
  operations are host-side tools; no credential is handed to the sandbox.
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
    gateway: { login, refresh, expiresAt, tools },   // auth, refresh, host-side tools
    sandbox: { tools },                               // stubs that call them
});
```

- Every connector with a session gets `checkSession()` automatically, as a function and as a
  tool: returns immediately when the session is valid beyond the threshold, refreshes when
  possible, otherwise raises an input request and waits. An agent that hits expired credentials
  can call it itself.
- A connector's credentialed tools have their implementation in the gateway half and a stub in
  the sandbox half (section 7).
- Workflows import the connectors they use, so the describe run tells the engine each workflow's
  requirements.
- Connectors with webhooks export a zod schema per event (`github.issueLabeled(label)`) and how the
  provider signs a delivery, for `webhook` triggers and for events into a running run (review
  watching).

## 9. Settings

| Where | What |
|---|---|
| **Git** (workflow repo) | workflows, agents (model ids), the entry file with triggers, static non-secret team config (start URLs, regions, accounts, thresholds) |
| **UI** (per user) | providers and their order, credentials, logins, overrides of static config |
| **Host config** | infrastructure only: gateway URL, credential store, KMS key |

- Credentials are stored server-side, encrypted per user (envelope encryption); locally in the OS
  keychain or an encrypted file. Same code path.
- Startup fails only on infrastructure. Missing user settings never block startup.
- Starting a run checks that workflow's requirements and shows a wizard with only what's missing.
- Triggers (section 4) are declared in git and configured in the UI: webhook signing secrets,
  enabling or pausing a trigger. A webhook or schedule that is declared but not configured yet
  doesn't start runs, and the UI says so.
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
- **Start buttons** come from the `userTrigger`s in the entry file, with the workflow's parameters
  as the form. Webhooks and schedules are listed next to them, with their state and their runs.

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

1. ~~**Sandbox spike (blocking).**~~ Resolved 2026-11-06: E2B Embed, microsandbox and gVisor all
   keep memory and processes across a pause and a restart of the host
   ([e2b-pause](../pocs/e2b-pause/README.md), [microsandbox-pause](../pocs/microsandbox-pause/README.md),
   [gvisor-pause](../pocs/gvisor-pause/README.md)). Backends as in section 3.
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
10. **Embed's idle cost**, only relevant if E2B is ever self-hosted (Embed isn't the local backend
    any more). Idle with no sandboxes, Embed takes about a quarter of
    a core (mostly ClickHouse) and 1+ GB RAM, with peaks over one core
    ([findings](../pocs/e2b-pause/README.md#findings)). Paused sandboxes survive an Embed
    restart, so the engine could start Embed when a run needs a sandbox and stop it once every run
    is paused or done (a warm start took about 70 s). Alternatives: trim Embed (ClickHouse is only
    for logs and metrics), or use E2B cloud for development and self-host only on a server.
    Whatever starts Embed also stops it: on the engine's own shutdown it pauses running sandboxes
    and stops Embed cleanly, and it recovers from an unclean stop on the next start, so nothing
    depends on a user stopping Docker first.
11. **Egress per backend.** The sandbox may reach only the gateway and public package sources. gVisor
    runs without a network, with the gateway as a bind-mounted Unix socket (proven). microsandbox's
    hostname rules only allow HTTPS through its TLS-intercepting proxy; the gateway itself should be
    an IP and port rule instead, which is unverified. E2B has allow/deny lists (proven for one host).
    Public package sources by hostname mean either interception or a gateway-side package proxy.
12. **microsandbox on native Windows** (Windows Hypervisor Platform, preview) passes the conformance
    suite on GitHub's hosted Windows runners in CI. Not yet tried on a developer machine.

13. **Typed fields on `requestUserInput`**, like `input(question, fields)`, so an agent can ask for a
    choice or a value instead of free text. An idea, not decided.

14. **Missed schedule ticks.** When the engine was down over a tick: run it once on start, or skip
    it. Leaning towards once, so a daily job isn't lost to a reboot.
15. **An MCP trigger.** Expose a workflow as an MCP tool, with its parameters as the tool's input
    schema ("a tool is also a function", pointed outward). Later; it fits `defineWorkflows` as one
    more trigger.

Out of scope for now: token and cost budgets.

## Roadmap

1. Spikes: sandbox pause (E2B, microsandbox, gVisor), `loop` result typing. Done.
2. MVP ([build plan](plans/mvp-build.md)): workflow runtime with events, `loop` with exits and
   `limit` on Pi Durable, `input`, the sandbox backends, gateway for model providers, a GitHub
   connector, triggers (user, webhook, schedule); first a minimal GitHub issue workflow (issue → fix → pull request → review comments),
   then the `example` workflow, both end to end from a CLI with sequential repositories.
3. Snapshots on wait (engine-side only; workflow code doesn't change).
4. `inDependencyOrder` with concurrency.
5. GitLab review watching; AWS and CodeArtifact through the gateway; `checkSession`.
6. UI, settings wizard, credential store.
7. Hosted, multi-user.

## Glossary

- **Run**: one execution of a workflow, in its own sandbox.
- **Gateway**: the host service that holds credentials and is the only egress needing them.
- **Loop token**: the single-use, rotating token for a loop's tool endpoint (section 7); held by
  the runtime, never by the agent. Workflow code has a run-level one.
- **Trigger**: what can start a run of a workflow (`userTrigger`, `webhook`, `schedule`), listed in
  the workflow repository's entry file, `workflows/main.mts`.
- **Exit tool**: `succeed`, `propose`, `verify` or `fail`, interpolated in a prompt; the only way
  an agent finishes.
- **Check**: a lazy verification used by `verify`.
- **Connector**: package with settings, a gateway half and a sandbox half (Jira, GitLab, AWS, …).
