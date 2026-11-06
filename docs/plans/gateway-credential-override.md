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

1. **Intercept the real URLs.** The sandbox's `HTTPS_PROXY` points at the gateway, and the sandbox
   image trusts the gateway's CA (system store, `NODE_EXTRA_CA_CERTS`, certifi, git's
   `http.sslCAInfo`). The CA cert isn't a secret. The gateway terminates TLS and picks the
   middleware by the request's host, so tools keep their real URLs and connectors don't rewire
   base URLs. Hosts without a middleware are refused, or passed through for public package sources.
   Costs: every runtime must trust the CA, and certificate pinning breaks.
2. **Proxy middleware per host decides how it works.** The connector's gateway half provides a
   middleware that sees each request to its host and rewrites it before it goes upstream. The
   middleware is what applies the credential, in whatever form the endpoint needs (a header, a
   query parameter, a provider-specific scheme). The default is strip, then set: drop any incoming
   `Authorization` header, cookies and API-key query parameters, then add the endpoint's
   credential. Never follow a redirect to another host with the credential attached.
3. **No allowlists.** The gateway doesn't keep method or path allowlists. Anything in the
   sandbox that reaches a host can use the credential's full permissions there, so what it
   can do is bounded by the credential itself: prefer short-lived or narrowly scoped credentials. A
   middleware may still refuse a request when its connector has a reason to. The run token is
   required on every request.
4. **Tools that insist on a token** get a fixed dummy value the gateway ignores. It isn't a secret.
5. **Two identities on one host** (two GitLab users) can't be told apart by host. Only for that
   case, a connector instance gets its own route on the gateway (`<gateway>/gitlab-bot`) and its
   sandbox half points that tool at it. Ties in with
   [open question 9](../design.md#open-questions).

## Out of scope for this mechanism

- **AWS SigV4** signs the whole request, so an override would mean re-signing, which
  [decisions](../decisions.md#credentials-and-settings) deferred in favour of the short-lived
  handout plus `aws:SourceIp`.
- **git** keeps the credential helper, or goes through the same interception over HTTPS.

## Worth borrowing from OpenShell

- Egress rules per destination **and per binary** (only `git` may reach the git host).
- Fail closed with a clear error when a middleware refuses a request.
- Flag changes that give a credential new reach (a new host or middleware) for human review.

## Fit with the sandbox backends

The sandbox's only way out is the gateway: a bind-mounted Unix socket under gVisor
(proven in [`pocs/gvisor-pause`](../../pocs/gvisor-pause/README.md)), which needs a small
in-sandbox forwarder from a loopback port to the socket for `HTTPS_PROXY`; an IP and port rule under
microsandbox (to verify, [open question 11](../design.md#open-questions)); E2B's allowlist hosted.
Interception also covers public package sources by hostname, which open question 11 already needs.

## Decisions

- **Every HTTP connector uses this.** Model providers, package registries, Jira, GitLab and any
  other HTTP API each get an override middleware. The exceptions stay as above: AWS SigV4 (short-lived
  handout) and git (credential helper).
- **No allowlists; the host's proxy middleware decides.** Each connector's gateway half provides
  the middleware for its hosts, which applies the credential (strip, then set by default) and may
  refuse requests. Reach is bounded by how the credential is scoped, not by a gateway allowlist.
- **Intercept the real URLs, routes only as a fallback.** The gateway intercepts by host through
  `HTTPS_PROXY` and its own CA; a separate route on the gateway exists only for two identities on
  one host.
