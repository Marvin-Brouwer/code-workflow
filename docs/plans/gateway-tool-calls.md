# Plan: credentialed tools run on the host

Status: decided 2026-11-06. Replaces the credential-injecting reverse proxy in
[design section 7](../design.md#7-credentials-and-the-gateway). Nothing is built yet.

## Idea

Anything that needs a credential runs on the host, not in the sandbox. The sandbox doesn't send
credentialed HTTP at all: it calls tools over one channel to the host, the host runs the tool with
the credential, and returns the result. A tool's own code is the limit on what a credential can
do, so there is nothing for the sandbox to misuse beyond calling the tools it was given.

This fits "a tool is also a function": the function lives on the host, and what the sandbox has is
a stub with the same signature that calls it.

Rejected on the way here (see [decisions](../decisions.md#credentials-and-settings)): placeholder
tokens swapped on the way out, a gateway route per endpoint with method/path allowlists, and an
intercepting HTTPS proxy with per-host credential middleware. All three let anything in the sandbox
that can reach the endpoint use the credential's full reach there, for example
`curl -X DELETE` on a project, because the gateway can't tell a tool's request from one the agent
typed.

## Rules

1. **Where a tool runs is part of the tool.** Tools without credentials (shell, file edits, tests,
   builds) run in the sandbox as now. Tools that need a credential (`jira.search`,
   `gitlab.openMergeRequest`, `github.comment`) run on the host. Connector packages provide both
   halves: the host implementation and the sandbox stub.
2. **One channel, JSON-RPC.** Calls go over the host↔sandbox channel the engine already has (the
   `WorkflowRuntime` seam): a gVisor bind-mounted Unix socket, microsandbox's IP and port rule, the
   network on E2B. A call carries the tool id and its validated input; the result or error comes
   back the same way. Aborting a call on either side aborts the other (cancel message → the host
   tool's `AbortSignal`).
3. **An endpoint per loop.** When a `loop` starts, the runtime registers the tools interpolated
   into its template with the host and gets back an endpoint and a nonce for that loop only. The
   host rejects calls to tools outside that set. The endpoint and nonce are revoked when the loop
   settles (exit, failure, limit or abort).
   **The nonce rolls:** each one is valid for a single call, and the response carries the next.
   Parallel tool calls in one turn each take their own nonce from a small pool the host hands out.
   A replayed or already-used nonce is refused, and because the runtime's own next call then
   fails, a stolen nonce doesn't go unnoticed: the host fails the loop and the run reports why.
4. **An endpoint for workflow code.** Tools called as functions from workflow code use a run-level
   endpoint that accepts the tools the workflow imports. Revoked when the run ends.
5. **Nonces stay out of the agent's reach.** They live only in the runtime's memory: not in env
   vars, files or prompts. Memory snapshots of a paused run contain them, but those stay on the
   host, and a nonce is useless once its loop has settled. Shell commands an agent
   runs execute as a separate unprivileged user that can't read the runtime's process, env or
   files. That matters for loops that run at the same time (`Promise.all`, `inDependencyOrder`) in
   one sandbox: without it, one agent's shell could read another loop's nonce. The rolling nonce
   catches theft after the fact; the separate user prevents it.
6. **Inputs are validated on the host**, against the tool's schema, before anything runs. The stub
   validates too, so the agent gets errors early, but the host's check is the one that counts.

## What doesn't fit the model yet

- **Model calls.** The loop itself calls models from the sandbox. Proposal: a `model` method on the
  same channel that carries the provider's native request and streams the native response back,
  so provider features (thinking, caching, headers) stay intact and usage is measured per loop.
- **Private package registries** (CodeArtifact NuGet/npm) are used by `npm install` and
  `dotnet restore` in the shell. Public sources stay reachable directly. For private ones: a
  read-only proxy with a read-only token, or install through a tool. To decide when the first
  workflow needs one.
- **git.** Pushing goes only through tools (`gitlab.push(repository)`), so the agent can't push to
  arbitrary remotes or branches. Fetching needs credentials too; a read-only credential helper or a
  checkout tool. To decide with `connector-github`.
- **AWS** stays the exception for now: the short-lived handout plus `aws:SourceIp`, as in design
  section 7. Wrapping the CLI in tools would lose too much.

## Worth borrowing from OpenShell

- Fail closed with a clear error when a call isn't allowed on its endpoint.
- Flag changes that give a workflow new reach (a newly imported credentialed tool) for human
  review.
