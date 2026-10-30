# Decisions: considered, rejected or superseded

Each entry: what was proposed, and why it was rejected or replaced. Reopen only if something
changes the trade-off, and say what changed.

## The three authoring models

Full sketches of all three exist; option C was chosen.

- **Option A: steps and combinators (superseded).** A workflow as a list of named step
  functions with `next()`, state keyed by step name, and `each`/`stagger`/`fork`/`repeat`. Steps
  existed because a step was the checkpoint boundary for resuming. Once durability moved to
  sandbox snapshots (every `await` is real), steps only served the UI, and the DSL became
  boilerplate with a learning curve: name-keyed state (`plan.plan.path`), implicit contracts
  between packages through step names, and four combinators to learn.
- **Option B: AI-first orchestration (rejected).** The whole workflow as one coordinator prompt
  with every building block as a tool. Reads as prose and leans fully on Pi Durable, but the
  control flow moves into unverifiable prose: approvals are requests rather than gates, order is
  a probability, long runs blow up the coordinator's context, diffs don't predict behaviour, and
  every tool needs input schemas just to pass data around. Agents with tools remain the right
  choice *inside* a workflow for genuinely exploratory work (comment triage).
- **Option C: plain async TypeScript (chosen).** Readable like B, deterministic like A, no DSL.
  Costs: no static graph before a run (the UI appends), and a lost snapshot restarts the run
  rather than one step (mitigated by idempotent primitives and Pi Durable sessions).

## Authoring details

- **Generators (`yield await step(...)`).** The value of a `yield` expression is what the engine
  passes to `next()`, so results lose their types.
- **Builder chains (`.step().create()`, `.then()`, `.returns()`, `.view()`).** Harder to read than
  plain code; forward references can't be typed.
- **Event wiring (`on(event, handler)`, `branch`, `gate`, `join`, `all`/`any`).** From the earlier
  AI-first design: doesn't read sequentially, edges live in closures, implicit shared state,
  ambiguous barriers in loops.
- **State machines (object of named states, statechart config, states returning machines).**
  Explored before option A; rejected for readability and because returned machines can't be
  reconstructed.
- **`goto`/named jumps.** Holes in state on forward jumps, stale-data rules on backward jumps,
  cancellation of siblings when jumping out of nested work. Plain loops cover the real cases.
- **Counters, random ids or source hashes as identity.** Shift, change per load, or change on every
  edit. (Relevant for Pi Durable session keys: key by call site and name.)
- **`loop(Schema)` or `.returns(Schema)` for agent results.** Replaced by exit tools in the
  template (`${succeed(Schema)}`): one mechanism for tools and results, and the model reads when to
  use them.
- **Hidden appended exit instructions.** Replaced by explicit exits in the template; the engine
  only nudges when a present exit isn't called.
- **A separate `${approve}` tool next to `${succeed}`.** Nothing stops the agent from succeeding
  without approval. Replaced by `propose(Schema)`: the only way out is through a human.
- **A retry loop around agent + checks in code.** Boilerplate, and the agent loses its context on
  every attempt. Replaced by `verify(...checks)` as an exit gate.
- **Agents shipped in packages.** Models, providers and conventions are workflow/team specific.
  Packages take agents as parameters.
- **`.view()` hooks or UI code in workflows.** The UI derives views from the event tree.

## Durability

- **Replay-based execution (Azure Durable Functions, Temporal style).** Code appears to wait but is
  re-executed with awaits answered from a journal. Hard to debug, and it imposes a determinism rule
  on all workflow code.
- **No durability (sandbox lives until the workflow ends).** Waits on approvals and reviews last
  days; a crash would redo all agent work.
- **Checkpoints at step boundaries only.** Superseded by sandbox snapshots plus Pi Durable.

## Credentials and settings

- **Credentials in the sandbox (env vars, `.env`, written credential files).** Agents have a shell
  and read untrusted input (stories, review comments): prompt injection can exfiltrate them, and
  they'd end up in snapshots stored for days.
- **`.env`-based provider config.** Replaced by UI-managed providers and an encrypted credential
  store; startup no longer fails on missing user settings.
- **Model roles/aliases (`model: 'planning'` mapped in config).** Rejected: agents name model ids
  directly; the gateway resolves them model-first.
- **Translating all model traffic to one wire format.** Loses provider-specific features; the
  gateway proxies each provider's native API instead.
- **AWS through a re-signing proxy with placeholder credentials.** Possible (SigV4 re-signing via
  `AWS_ENDPOINT_URL`), but breaks presigned URLs, chunked uploads, and credentials passed to
  containers. Deferred; short-lived handout plus `aws:SourceIp` gives nearly the same protection
  with full compatibility.
- **An `aws.session(() => ...)` scope.** Replaced by `checkSession()`, usable from code and as an
  agent tool, so an agent can recover from expired credentials itself.
- **Account and permission set inline in workflow code.** Moved to connector settings (static
  config or UI).
- **Threshold as a `checkSession` argument.** Moved to connector settings.
- **Refreshing the human session as long as any workflow exists.** Keeps a human identity live and
  unattended for days. Refresh only while runs actively need it and no interaction is needed; for
  truly unattended long work, use a workload identity (IAM role for the gateway) instead of
  stretching a human session.

## Sandboxes

Compared for per-run isolation with memory-preserving pause (October 2026):

- **E2B**: chosen. Pause keeps memory and processes; paused sandboxes are kept indefinitely; open
  source (Apache-2.0) with single-node self-hosting (Embed) and the same API in the cloud. Pause
  support in Embed still needs to be verified.
- **Fly Sprites**: RAM snapshots on idle, no runtime cap, but cloud only. Fallback candidate.
- **Daytona**: memory is only kept for VM sandboxes, not containers.
- **microsandbox**: local microVMs incl. Windows; beta.
- **Trigger.dev**: CRIU checkpoints only for its supported waits; real checkpoints need Kubernetes
  with CRIU; it's a whole task platform.
- **Vercel Sandbox, Cloudflare Sandbox**: filesystem-only snapshots.
- **Sandcastle, Flue**: agent-in-sandbox runners/harnesses without memory durability.
