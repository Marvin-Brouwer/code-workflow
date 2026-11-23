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
`examples/github-issue`, opens the UI, clicks its start button, gets a wizard with only what's
missing (a provider key, `github/token`), fills it in, starts the run, and answers its input
requests in the run view, without touching the CLI after `mesh-flow deploy`.

## What gets built

A new package, `@mesh-flow/ui`: a [rooted](https://github.com/rooted-org/rooted) app built with
Vite into static files, plus a `mesh-flow ui` command in the engine that serves them.

### 1. `mesh-flow ui` (host)

A command next to `serve`, not part of it, for the same reason the provider commands aren't: the
settings work on the home's files without a running engine, and a running one sees the change at
once.

- Listens on `127.0.0.1`, on a free port (`--port` to pick one), serves the built UI and an API
  under `/api`, and opens the browser (`--no-open` to only print the URL).
- **Access** is one middleware in front of `/api`:
  - the URL carries a token made at start (`/?token=...`); the first request swaps it for an
    `HttpOnly`, `SameSite=Strict` cookie, named after the port so two UIs don't overwrite each
    other's, and redirects to drop it from the address bar; every API call needs the cookie;
  - the `Host` header must be the address it listens on, against DNS rebinding;
  - browsers count every port on 127.0.0.1 as the same site, so the cookie alone doesn't keep out a
    dev server's page on another port: a request is refused unless its `Sec-Fetch-Site` is
    `same-origin` or `none` (another port sends `same-site`) and its `Origin`, when it has one, is
    the UI's own;
  - a request that changes something must send `Content-Type: application/json`, which a plain
    form on another site can't.

  This is the control socket's rule: only the user who started it gets in. It has the same known
  gap: the token is on the command line that opens the browser, which other users of the machine
  can read, as they can reach the control socket's named pipe on Windows. It's only the local way
  in: hosted (roadmap step 7) swaps the middleware for a real sign-in per user. The UI itself only
  knows it talks to `/api` with a cookie, so it doesn't change for that.
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
GitHub connector starts reporting `github/token`.

### 3. Tool calls in the event tree (core)

- `tool-call-succeeded` carries the call's result, cut to a named size limit (a few KB), with binary
  content left out, so a chip can show it. The text is for reading, not for parsing: a cut one says
  how much is left out and is marked as cut. Results are already in the sandbox, so this shows
  nothing the run didn't have.
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
| `start` | the workflow's parameters as a form, after the wizard | start a run (with an idempotency key per form, so a double click starts only one run), then go to it |
| `settings/providers` | providers in order, kind, whether a key is set | add, set key, reorder, remove |
| `settings/credentials` | credential names, never their values | set, remove; generate a webhook secret |
| `settings/connectors` | loaded connectors, and sign-ins under way with their URL and code | sign in |

- **The run view** reads top to bottom as bars, one per step, built from the event tree:
  - a bar per tool call from code (`tool-call`, `from: 'code'`), titled by the tool, with its
    status from `-succeeded`/`-failed`;
  - a bar per agent invocation (`loop`): the text of its `turn`s as a stream, with its tool and
    exit calls as chips in it; a chip opens the call's input, result or error. A chip has failed
    when it has `-failed` or a `tool-error` under it; the agent's coding tools (read, write, bash)
    are a single `tool-call` event with a `failed` flag and no end event;
  - a bar for `input` (with the answer form in it), `wait` and login requests;
  - steps that overlap (`Promise.all`, `inDependencyOrder` nodes) are bars stacked by start time;
    a node is a bar grouping its own steps;
  - a restart adds an attempt, and bars group by attempt; the current attempt is the highest one
    in the event ids. A step with no end event is open (running, waiting or paused, as the run is)
    when it is in the current attempt of a run that isn't finished or restartable, and interrupted
    otherwise.

  Everything in the tree is written in the sandbox and can carry prompt-injected text, so the page
  shows it as text only (no HTML, no Markdown rendered to HTML), and the server sends a
  `Content-Security-Policy` that allows only its own scripts. Bars are collapsed except the latest
  and failed ones; opening one shows more. Connectors don't ship UI: every step gets these bars from
  the tree. Other views come later; see Not in this step.
- **The wizard** is the start page asking the engine what the app is missing first, and showing
  one form per `fix` before the parameters. Nothing missing, no wizard.
- **Forms** come from JSON Schema, which both workflow parameters and input request `fields` are.
  A small renderer covers flat objects of strings, numbers, booleans, enums and arrays of enums,
  which is what `input.text/yesNo/choice/choices` make; anything else gets a JSON text area that is
  checked by the same schema before it's sent.
- **Updates** poll the API on the pages that change (runs, one run, sign-ins) every `pollInterval`,
  a `Duration` of two seconds. They stop with the component's abort signal (rooted's mount `signal`,
  taken as `signal: abortSignal`), so leaving the page stops them. The next poll waits for the last
  one to settle, an answer form keeps what was typed across updates, and an answer that another tab
  or the CLI gave first says so. Server-sent events can replace polling behind the same data later.
- **Shared state** in `@rooted/store` only where two components need it: whether the engine is
  reachable (shown in the shell on every page), and the run list. The rest is local to `onMount`.
- Styling follows rooted's four layers: `index.tokens.css` (a few greys and spacing),
  `index.theme.css` (system font, plain defaults for tables, forms and buttons), the shell, and a
  short stylesheet per component only where layout needs it.

## As built

- `mesh-flow ui` loads `@mesh-flow/ui/server` from where it runs, as connectors are loaded, instead
  of the engine depending on the UI. The UI depends on the engine (its control client, settings
  functions and types), so the other way round would be a cycle, and an engine without a UI stays as
  it is.
- The settings functions the CLI's provider commands had inline (`putProvider`, `setProviderKey`,
  `removeProvider`, `listProviders`) moved into the engine, so the CLI and the UI share them.
- The engine's control API lists the connectors it loaded (`GET /connectors`: name, package, whether
  it signs in), so the connectors page can offer a sign-in by connector name; the settings only know
  package names.
- The wizard's fix-to-form mapping is a switch in the `FixForm` component, too small to test apart.
  The tests cover the JSON Schema form logic (`fieldsOf`, `valueOf`, `checkAgainst`) and that the
  page's copies of the engine's answer schemas match the originals, since the page can't import the
  Node packages.
- Runs update by push, not polling (Marvin, 2026-11-23): the engine's control API streams which run
  changed as server-sent events (`GET /changes`: `ready`, then `run` with its id after each record
  or events write, and a `heartbeat` every 15 seconds), and the UI's server passes it through at
  `/api/engine/changes`. Server-sent events and not a websocket: updates only go one way, actions
  stay POSTs, and it's plain HTTP behind the same access checks. Against a view that silently stops
  updating, the page counts the stream as dead after 35 seconds without a heartbeat, connects again
  with a growing wait, refetches everything on every (re)connect, refreshes every two seconds while
  it's down, and shows "Live" or "Reconnecting" in the shell. The settings still poll.
- Review on #54 (Marvin, 2026-11-23): the stream is `GET /events` (was `/changes`) and also says
  which sign-in changed, such as the AWS login, so the sign-ins list follows it instead of polling.
  The run view follows its own stream instead: `GET /runs/:run/events` asked for as
  `text/event-stream` sends `run` with the record and `event` with each event, numbered for
  `Last-Event-ID`, first all of them and then each change; plain `GET` still answers the JSON list.
  Both streams are behind the UI's access check, which a hosted sign-in replaces for every route;
  EventSource sends the cookie on the same origin, so `withCredentials` only matters cross-origin.
- A run's requests are answered in a "Waiting on" section at the top of the run page rather than
  inside their bars, so what needs someone is the first thing on it; the input bar shows the
  question and whether it was answered.
- Forms check a value with `z.fromJSONSchema` of the same schema the engine checks it with; a schema
  zod can't read is left to the server.
- The page's Vite config is plain, with rooted's CSS loader and route discovery, not
  `rootedManifest` from `@rooted/application`: its PWA, SEO and pre-rendering are for public sites.

## Not in this step

- Turning a trigger on and off ([design section 9](../design.md#9-settings)): there is no engine
  state for it yet.
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
3. `mesh-flow ui`: the server, access, the settings and runs API, and the engine's
   `GET /apps/:name/missing`, so the wizard can ask before it starts anything. `@mesh-flow/ui` as
   an empty rooted app with the shell, so the command has something to serve.
4. Settings pages and the wizard's forms.
5. Apps, the start page with the wizard, and the run view.
