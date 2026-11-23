# Plan: the UI

Status: agreed 2026-11-18. Covers roadmap step 6 of [`../design.md`](../design.md#roadmap): the
UI, the settings wizard and the credential store, with a simple run view. The flight data recorder
([issue #2](https://github.com/Marvin-Brouwer/code-workflow/issues/2)) is separate and not part of
this. Hosted and multi-user is step 7.

## Goal

Everything the CLI does day to day can be done in a browser on the same machine: see runs and
answer them, start a workflow from its button, and set up providers, keys and credentials. The
look is a wireframe on purpose: plain HTML elements, borders, one font, no color beyond grey.
Design comes after the roadmap is done and tested.

Done when: from a fresh engine home with the GitHub connector added, a user deploys
`examples/github-issue`, opens the UI, clicks
its start button, gets a wizard with only what's missing (a provider key, `github/token`), fills it
in, starts the run, and answers its input requests in the run view, without touching the CLI after
`mesh-flow deploy`.

## What gets built

A new package, `@mesh-flow/ui`: a [rooted](https://github.com/rooted-org/rooted) app built with
Vite into static files, plus a `mesh-flow ui` command in the engine that serves them.

### 1. `mesh-flow ui` (host)

A command next to `serve`, not part of it, for the same reason the provider commands aren't: the
settings work on the home's files without a running engine, and a running one sees the change at
once.

- Listens on `127.0.0.1`, on a free port (`--port` to pick one), serves the built UI and an API
  under `/api`, and opens the browser (`--no-open` to only print the URL).
- **Access:** the URL carries a token made at start (`/?token=...`). The first request swaps it for
  an `HttpOnly`, `SameSite=Strict` cookie, named after the port so two UIs don't overwrite each
  other's, and redirects to drop it from the address bar. Every API call needs the cookie, and the
  `Host` header must be the address it listens on. Browsers count every port on 127.0.0.1 as the
  same site, so the cookie alone doesn't keep out a dev server's page on another port: a request
  whose `Origin` or `Sec-Fetch-Site` says it comes from another origin is refused, and a change has
  to be JSON. With that, another site in the browser (DNS rebinding included) can't use it. This is
  the control socket's rule: only the user who started it gets in. The same known gap applies too:
  the token is on the command line that opens the browser, which other users of the machine can
  read, as they can reach the Windows pipe. This is only the local way in: access is
  one middleware in front of `/api`, and hosted (roadmap step 7) swaps it for a real sign-in per
  user. The UI itself only knows it talks to `/api` with a cookie, so it doesn't change for that.
- **Runs and apps** go to the running engine over its control socket, the same routes the CLI uses.
  When no engine runs, those pages say so and how to start it; settings still work.
- **Settings** use the gateway home directly, through the same functions the CLI commands call
  (`providers.put/order/remove`, `credentials.set/remove/names`). No second implementation.
- Takes a required `AbortSignal` like everything else, and Ctrl+C closes it promptly, even with
  requests still open.

### 2. Structured missing settings (engine)

`engine.missingSettings` returns lines of text today. The wizard needs to know which form to show,
so each becomes `{ message, fix }`, with `fix` one of:

- `{ kind: 'provider', model }`: no provider serves this model; add one;
- `{ kind: 'provider-key', provider }`: the provider serves it but has no key; set one;
- `{ kind: 'credential', name }`: set this credential (connectors give the name they look up);
- `{ kind: 'connector-for-tools', tools }` and `{ kind: 'connector', connector }`: no loaded
  connector brings these host tools, or a registry needs a connector that isn't loaded (fixed from
  the CLI only: it needs a package installed and the engine restarted);
- `{ kind: 'other' }`: the message is all there is.

The CLI keeps printing `message`. `ConnectorHost.missingSettings` changes the same way, and the
GitHub connector starts reporting `github/token`. The control API gets `GET /apps/:name/missing`,
so the wizard can ask before it starts anything.

### 3. Tool calls in the event tree (core)

- `tool-call-succeeded` carries the call's result, cut to a named size limit (a few KB), with
  binary content left out, so a chip can show it. Cutting keeps the JSON valid (long strings are
  shortened) and marks the result as cut. Results are already in the sandbox, so this shows nothing the run didn't have.
- A tool may give `describe(input, output)`, which returns a line of text that titles its bar
  ("Collected issue #63"). Without one, or when it throws, the bar is titled by the tool's name; a
  failing `describe` never fails the call.

### 4. The pages

Vertical slices, as rooted lays an app out, one folder per page with its `_routes.mts`:

| Slice | Shows | Does |
|---|---|---|
| `runs` | every run: workflow, app, status, what it waits on; "needs input" and "needs login" on top | open a run |
| `runs` (one run) | status, the run as bars (below), usage per model when done | answer a request, stop, resume, restart, sign in |
| `apps` | deployed apps, their workflows and triggers; webhooks and schedules with whether a secret is set | start a workflow from its button |
| `start` | the workflow's parameters as a form, after the wizard | start a run (with a key per form, so a double click starts one), then go to it |
| `settings/providers` | providers in order, kind, whether a key is set | add, set key, reorder, remove |
| `settings/credentials` | credential names, never their values | set, remove; generate a webhook secret |
| `settings/connectors` | loaded connectors, and sign-ins under way with their URL and code | sign in |

- **The run view** reads top to bottom as bars, one per step, built from the event tree:
  - a bar per tool call from code (`tool-call`, `from: 'code'`), titled by the tool, with its
    status from `-succeeded`/`-failed`; a `tool-error` under it marks it failed, and the agent's
    own coding tools (read, write, bash) are one `tool-call` event with `failed` on it;
  - a bar per agent invocation (`loop`): the text of its `turn`s as a stream, with its tool and
    exit calls as chips in it; a chip opens the call's input, result or error;
  - a bar for `input` (with the answer form in it), `wait` and login requests;
  - steps that overlap (`Promise.all`, `inDependencyOrder` nodes) are bars stacked by start time;
    a node is a bar grouping its own steps;
  - a restart adds an attempt, and bars group by attempt; a step without an end event is running
    only in the current attempt of a running run, and interrupted otherwise.

  Everything in the tree is written in the sandbox and can carry prompt-injected text, so the page
  shows it as text only (no HTML, no Markdown rendered to HTML), and the server sends a
  `Content-Security-Policy` that allows only its own scripts. Bars are collapsed except the latest and failed ones; opening one shows more. Connectors don't
  ship UI: every step gets these bars from the tree. Other views come later; see Not in this step.
- **The wizard** is the start page asking the engine what the app is missing first, and showing
  one form per `fix` before the parameters. Nothing missing, no wizard.
- **Forms** come from JSON Schema, which both workflow parameters and input request `fields` are.
  A small renderer covers flat objects of strings, numbers, booleans, enums and arrays of enums,
  which is what `input.text/yesNo/choice/choices` make; anything else gets a JSON text area that is
  checked by the same schema before it's sent.
- **Updates** poll the API on the pages that change (runs, one run, sign-ins) every `pollInterval`, a
  `Duration` of two seconds. They stop with the component's abort signal (rooted's mount `signal`,
  taken as `signal: abortSignal`), so leaving the page stops them. The next poll waits for the last one to
  settle, an answer form keeps what was typed across updates, and an answer that another tab or
  the CLI gave first says so. Server-sent events can replace it
  behind the same data later.
- **Shared state** in `@rooted/store` only where two components need it: whether the engine is
  reachable (shown in the shell on every page), and the run list. The rest is local to `onMount`.
- Styling follows rooted's four layers: `index.tokens.css` (a few greys and spacing),
  `index.theme.css` (system font, plain defaults for tables, forms and buttons), the shell, and a
  short stylesheet per component only where layout needs it.

## Not in this step

- Turning a trigger on and off ([design section 9](../design.md#9-settings)): there is no engine state for it yet.
- Adding a connector from the UI: it means installing a package where the engine runs.
- Overrides of static config, and team-level providers.
- The flight data recorder, and the natural views of [design section 10](../design.md#10-ui-contract)
  (lanes for `inDependencyOrder`, a feed for review handling), which can come later as first-party
  renderers in `@mesh-flow/ui`: the run view is the event tree as a list.
- Remote access. The UI is for the machine the engine runs on, as the control socket is.

## Tests

- `mesh-flow ui`: the token swap, a request without the cookie, a wrong `Host`, a request from
  another origin, settings writes that the CLI then reads, the runs routes with no engine running,
  and close with a request that never settles (such as a sign-in, which stays open until it's done).
- The run view: a `<script>` in a turn shows as text.
- The form renderer and the wizard's fix-to-form mapping as unit tests.
- One browser test (Playwright, with the runner's Chrome on CI) against a stand-in engine: open,
  start a run through the wizard, answer it. `@mesh-flow/ui` joins the CI workflow's package
  filters.

## Delivery

Stacked PRs, each on the one before:

1. This plan.
2. Structured missing settings in the engine and the connectors; tool results and `describe` in
   the event tree.
3. `mesh-flow ui`: the server, access, the settings and runs API. `@mesh-flow/ui` as an empty
   rooted app with the shell, so the command has something to serve.
4. Settings pages and the wizard's forms.
5. Apps, the start page with the wizard, and the run view.
