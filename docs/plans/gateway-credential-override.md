# Plan: per-endpoint credential override in the gateway

Status: decided 2026-11-06. This is the gateway's model for every HTTP connector, and replaces the
credential-injecting reverse proxy in [design section 7](../design.md#7-credentials-and-the-gateway).
Nothing is built yet.

## Idea

No placeholder tokens in the sandbox. Instead, the gateway has one proxy rule per endpoint that
**always** sets that endpoint's credential, whatever the sandbox sent. Only the credentials that
belong to an endpoint are ever used on it, and there is nothing in the sandbox to misuse, leak or
swap.

Compared with placeholder substitution (as in NVIDIA OpenShell and microsandbox's secrets): there a
token in the sandbox's environment is swapped for the real credential on the way out. That still
puts a value in the sandbox that means "use credential X", and the swap has to find it in headers,
query strings or bodies.

## Rules

1. **A route per endpoint**, with its own base URL on the gateway (`<gateway>/gitlab`,
   `<gateway>/jira`, a provider's API, …). Tools are pointed at that base URL by the connector's
   sandbox half. The rule belongs to the route, not to a `Host` header the sandbox chooses, and the
   sandbox needs no CA to trust a TLS-intercepting proxy.
2. **Override means strip, then set.** Drop any incoming `Authorization` header, cookies and API-key
   query parameters, then add the endpoint's credential. Never follow a redirect to another host
   with the credential attached.
3. **Scope what the credential can do through the route.** Anything in the sandbox that reaches the
   route can use the credential's full permissions there, so each route gets a method and path
   allowlist (a workflow that opens merge requests doesn't need `DELETE /projects`). The run token
   is required on every route. Prefer short-lived or narrowly scoped credentials.
4. **Tools that insist on a token** get a fixed dummy value the gateway ignores. It isn't a secret.
5. **Keyed by connector instance, not by host**, so two identities for one endpoint (two GitLab
   users, two AWS accounts) are two routes. Ties in with
   [open question 9](../design.md#open-questions).

## Out of scope for this mechanism

- **AWS SigV4** signs the whole request, so an override would mean re-signing, which
  [decisions](../decisions.md#credentials-and-settings) deferred in favour of the short-lived
  handout plus `aws:SourceIp`.
- **git** keeps the credential helper, or goes through the same route over HTTPS.

## Worth borrowing from OpenShell

- Egress rules per destination **and per binary** (only `git` may reach the git host).
- Fail closed with a clear error when a request doesn't match its route's allowlist.
- Flag changes that give a credential new reach (a new route, method or path) for human review.

## Fit with the sandbox backends

The sandbox's only way to these routes is the gateway: a bind-mounted Unix socket under gVisor
(proven in [`pocs/gvisor-pause`](../../pocs/gvisor-pause/README.md)), an IP and port rule under
microsandbox (to verify, [open question 11](../design.md#open-questions)), E2B's allowlist hosted.

## Decisions

- **Every HTTP connector uses this.** Model providers, package registries, Jira, GitLab and any
  other HTTP API each get an override route. Model providers already reach the gateway through a
  `baseUrl`, so they are routes like the rest. The exceptions stay as above: AWS SigV4 (short-lived
  handout) and git (credential helper).
- **Allowlists live in the connector only.** Each operation a connector offers declares the methods
  and paths it calls. A route allows the union for the operations the workflows using it import,
  which the engine knows because workflows import their connectors. There is no team-config
  override: to change what a route allows, change the connector. A connector version or a newly
  used operation that widens a route (a new method or path) is flagged for human review, as
  borrowed from OpenShell above.
