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
   into its template with the host and gets back an endpoint and a token for that loop only. The
   host rejects calls to tools outside that set. The endpoint and token are revoked when the loop
   settles (exit, failure, limit or abort).
   **The token rotates** (single-use token rotation with reuse detection, as with OAuth refresh
   tokens): each one is valid for a single call, and the response carries the next.
   Parallel tool calls in one turn each take their own token from a small pool the host hands out.
   A replayed or already-used token is refused, and because the runtime's own next call then
   fails, a stolen token doesn't go unnoticed: the host fails the loop and the run reports why.
4. **An endpoint for workflow code.** Tools called as functions from workflow code use a run-level
   endpoint that accepts the tools the workflow imports. Revoked when the run ends.
5. **Tokens stay out of the agent's reach.** They live only in the runtime's memory: not in env
   vars, files or prompts. Memory snapshots of a paused run contain them, but those stay on the
   host, and a token is useless once its loop has settled. Shell commands an agent
   runs execute as a separate unprivileged user that can't read the runtime's process, env or
   files. That matters for loops that run at the same time (`Promise.all`, `inDependencyOrder`) in
   one sandbox: without it, one agent's shell could read another loop's token. Rotation
   catches theft after the fact; the separate user prevents it.
6. **Inputs are validated on the host**, against the tool's schema, before anything runs. The stub
   validates too, so the agent gets errors early, but the host's check is the one that counts.

## Everything credentialed is a tool call

The sandbox has no other way out with a credential, so these are tool calls like the rest:

- **Model calls.** The loop's own model calls go over the channel as a host-side call that carries
  the provider's native request and streams the native response back, so provider features
  (thinking, caching, headers) stay intact and usage is measured per loop. Calling another agent
  is already a tool: `agent.as(name, …)`.
- **git.** Clone, fetch and push are host-side functions called from workflow code, not agent
  tools: the workflow checks out before a loop and pushes after `verify` passes. Local git (status,
  diff, commit) needs no credential and stays in the sandbox. The earlier prototype's `git`
  package backs the host side.
- **Private package registries** (CodeArtifact NuGet/npm). The package manager in the sandbox is
  pointed at a local shim that turns each package fetch into a read-only tool call
  (`registry.fetch(package, version)`). Public package sources need no credential and stay
  reachable directly.
- **AWS.** Host-side tools per operation a workflow needs, using the gateway's role credentials.
  No credential handout to the sandbox, so no raw `aws` CLI there.

## Worth borrowing from OpenShell

- Fail closed with a clear error when a call isn't allowed on its endpoint.
- Flag changes that give a workflow new reach (a newly imported credentialed tool) for human
  review.
