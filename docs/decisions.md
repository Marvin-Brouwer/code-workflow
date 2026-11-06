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

## Agent loops

Came out of comparing the design with humanlayer's 12-factor-agents (factors 3, 9 and 13) in
November 2026. Design section 4 ([Loop limits](design.md#loop-limits), [Context](design.md#context),
[Pre-fetching](design.md#pre-fetching)) and section 6 hold what was chosen.

- **Context compaction (summarising or dropping old turns when the context fills up).** Hidden
  engine behaviour that changes what the agent knows without a trace in the diff. Workflows avoid
  long contexts instead: one loop per task, results as values and files, values that control their
  own rendering. Hitting the limit fails the loop.
- **Output truncation by the engine.** The engine can't know which part of a tool's output
  matters. A tool with large output writes it to a file and returns a summary plus the path.
- **Limits per tool (`${limit(jira.search, 3)}`, or a limit in the tool definition).** How often a
  call is reasonable depends on the task, not the tool, and per-tool budgets spread one decision
  over many places. Replaced by one loop-wide `limit` line in the template.
- **Counting human wait time in `minutes`.** A limit that a slow approval can exhaust punishes the
  agent for the human. Only the agent's own runtime counts.
- **Handing thrown errors back to the agent, or retrying in the engine.** Makes failure handling
  implicit: a broken credential or a bug turns into the agent improvising around it, and retries
  hide flakiness. Errors bail by default; a tool that wants the agent to see a failure returns it
  as a result and retries its own transient failures.
- **A pre-fetch feature (declaring tools to run before the loop).** Not needed: a tool is also a
  function, so code calls it and interpolates the result.

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

Compared for per-run isolation with memory-preserving pause (October 2026), then tested without
Docker (November 2026, POCs in `pocs/`). Outcome: E2B Cloud hosted, microsandbox locally with a
hypervisor, gVisor locally without one (design section 3).

- **E2B**: chosen for hosted (E2B Cloud). Pause keeps memory and processes; paused sandboxes are
  kept indefinitely; open source (Apache-2.0).
- **E2B Embed locally (superseded).** Works, including across a restart (POC), but needs Docker
  Engine on the same Linux as `/dev/kvm`, an Ubuntu-shaped host (on Docker Desktop and NixOS only
  through a Docker-in-Docker container), 12 GiB RAM and 20 GiB disk, and costs a quarter of a core
  while idle. On NixOS on WSL, mirrored networking plus Docker's raw DROP rule made it unreachable.
  Setup effort was the deciding factor. Still the option for self-hosting on a server.
- **microsandbox**: chosen for local. microVMs (libkrun) from an npm package with no daemon; full
  snapshots keep memory and processes, also across `wsl --shutdown` (POC). Beta. A full snapshot is
  refused while managed jobs run, and hostname allowlists need its TLS-intercepting proxy.
- **gVisor**: chosen as the local fallback without a hypervisor. `runsc checkpoint`/`restore`
  keeps memory and processes across a restart (POC), needs no KVM, but needs root and Linux, and the
  engine builds the rootfs and networking itself. Pause writes all memory to disk first (0.4 s on
  the dev machine, 4 s on a slow disk).
- **Fly Sprites**: RAM snapshots on idle, no runtime cap, but cloud only.
- **Daytona**: memory is only kept for VM sandboxes, not containers.
- **BoxLite, smolvm**: daemonless microVMs, but disk-only persistence.
- **Firecracker or Cloud Hypervisor driven directly**: solid memory snapshots, but that means
  rebuilding what E2B packages (kernel and rootfs builds, tap networking, snapshot bookkeeping).
- **V8 isolates (isolated-vm, Node `vm`, Deno, workerd), WASM/WASI, QuickJS heap snapshots**:
  can't run git, toolchains or a shell, and V8 can't snapshot a running heap. Splitting workflow
  code (in QuickJS) from toolchains breaks "the debugger shows the real stack".
- **Kubernetes**: schedules containers but gives no memory snapshot (kubelet checkpoints through
  CRIU can't be restored as a normal operation), and plain pods isolate too little for agents with
  a shell. Not needed: hosted sandboxes are E2B's, the engine's services can run anywhere.
- **NVIDIA OpenShell**: filesystem-only persistence ("does not restore process memory"), runs on
  Docker, Podman, Kubernetes or libkrun. Its credential placeholders and per-binary egress rules are
  worth comparing with the gateway, not a sandbox for runs.
- **Trigger.dev**: CRIU checkpoints only for its supported waits; real checkpoints need Kubernetes
  with CRIU; it's a whole task platform.
- **Vercel Sandbox, Cloudflare Sandbox**: filesystem-only snapshots.
- **Sandcastle, Flue**: agent-in-sandbox runners/harnesses without memory durability.

## Tooling

- **ESLint with typescript-eslint (superseded by oxlint).** The scaffold used ESLint's
  `strictTypeChecked` and `stylisticTypeChecked`. Replaced with oxlint, type-aware through
  oxlint-tsgolint, by preference: much faster, two dependencies instead of four. The ruleset is
  `correctness` and `suspicious` plus the type-aware rules the scaffold relied on, listed in
  `.oxlintrc.json`; ESLint's stylistic rules have no one-to-one replacement.
