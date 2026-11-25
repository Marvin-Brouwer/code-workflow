# `@mesh-flow/ui`

The mesh-flow UI: the runs and their requests, starting a workflow from its button, and the settings (provider keys and credentials), in a browser on the machine the engine runs on. It's a wireframe on purpose: plain elements, borders, greys. The design comes later.

The page is a [rooted](https://github.com/rooted-org/rooted) app. Its server, which `mesh-flow ui` loads, serves the page and an API over the engine's control socket and the home's settings, on 127.0.0.1 only.

## Use

Install it where `mesh-flow` runs, the same as a connector, and serve it:

```bash
pnpm add @mesh-flow/ui
mesh-flow ui            # serves it on a free port and prints the address
mesh-flow ui --port 4800
```

Open the address it prints in the browser you choose: its token lets one browser in. Credentials, connectors and removing a provider's key work without a running engine; the providers, setting a key, runs and triggers need `mesh-flow serve`, since the deployed app declares the providers and a key is set for where its provider sends it. Ctrl+C stops it. The page needs a current browser: Chrome 117, Firefox 119 or Safari 17.4, or later.

To serve it from code of your own:

```ts
import { serveUi } from '@mesh-flow/ui/server'

const stopping = new AbortController()
const served = await serveUi({
	home: '/home/me/.local/share/mesh-flow',
	keychain: true,
	port: 0,
	abortSignal: stopping.signal,
})
console.log(served.url)

stopping.abort()
await served.closed
```

## Access

The server listens on 127.0.0.1 and lets in only the browser that opened its address:

| Check | Answer when it fails |
|---|---|
| the `Host` header is the address it listens on, so a site pointing its own name at 127.0.0.1 (DNS rebinding) gets nothing | 403 |
| the request comes from the UI's own page or from opening its address: `Sec-Fetch-Site` is `same-origin` or `none`, and `Origin`, when sent, is the UI's own. A page on another port of 127.0.0.1 counts as the same site to the browser, so the cookie alone wouldn't keep it out | 403 |
| `?token=` is the printed token; it's swapped for an `HttpOnly`, `SameSite=Strict` cookie named after the port (`mesh-flow-ui-4800`), so two UIs keep their own, and dropped from the address bar | 401 |
| every other request has that cookie | 401 |
| a change is sent as JSON, which a form on another site can't send without asking first | 415 |

Every answer has a `Content-Security-Policy` that lets the page run only its own scripts, since a run's events come from the sandbox and can carry prompt-injected text, which the page shows as text.

This is the local way in. The token only goes to the terminal, never on a command line that other users of the machine can read; they can still reach the control socket's named pipe on Windows. Hosted (roadmap step 7), a sign-in per user takes its place in front of the same routes; the page only knows it talks to `/api` with a cookie.

## The API

| Route | Does |
|---|---|
| `GET /api/engine/status` | `{ running }`: whether an engine answers on the home's socket |
| `/api/engine/runs`, `/runs/:run`, `/runs/:run/events`, `/runs/:run/answers/:request`, `/runs/:run/stop`, `/resume`, `/restart` | the engine's control API, the same calls as the CLI; 503 when no engine runs |
| `GET /api/engine/events` | the engine's event stream, as server-sent events: which run or sign-in changed, and a heartbeat every 15 seconds |
| `GET /api/engine/runs/:run/events` as `text/event-stream` | one run's stream: its record and its events, first all of them and then each change, and its sign-ins |
| `GET /api/engine/connectors` | the connectors the engine loaded, and which sign in |
| `GET /api/engine/sign-ins`, `POST /api/engine/sign-ins/:connector` | sign-ins under way, and waiting for one |
| `GET /api/engine/app`, `GET /api/engine/app/missing` | the deployed app (`null` before the first deploy), and what it still needs before it can run |
| `GET /api/settings/providers`, `GET /api/settings/providers/:name/models`, `PUT` and `DELETE /api/settings/providers/:name/key` | the providers the deployed app's config declares, whether each has a key, the models a provider with a key lists (asked of the provider), and setting and removing a key, as `mesh-flow provider`; all but `DELETE` are 503 when no engine runs |
| `/api/settings/credentials`, `/credentials/:name` | credential names, setting and removing them; values never come back |
| `GET /api/settings/connectors` | the connector packages the engine loads |

Deploying isn't in it: that stays with the CLI and CI.

A tab follows one stream at a time: the run page's own stream takes the place of the engine's while it's open. A browser keeps six connections to an HTTP/1.1 address, and each open stream holds one, so many tabs of the UI at once can leave a tab waiting for a connection.

## The pages

| Page | Shows | Does |
|---|---|---|
| `/` and `/runs/` | a bar when the app still needs settings, and every run: workflow, status, what it waits on; those that need someone on top | open a run, start a new one when the app has a user trigger |
| `/runs/:id/` | its status, what it waits on, its steps as bars, its usage once done | answer a question, stop, resume, restart |
| `/triggers/` | the app's version and its triggers: a schedule's cron, a webhook's secret set or not | start a workflow from its user trigger |
| `/start/` | the app's user triggers, when it has more than one | pick one |
| `/start/:trigger/` | what the app still needs, then the workflow's parameters | set what's missing, start the run |
| `/setup/` | what the app still needs before a run can start | set what's missing |
| `/settings/providers/` | the providers the app's config declares, in the order models are looked up: kind, base URL, whether each has a key, and, for one with a key, its models (asked of the provider) and which agents can use | a link to the key's row on the credentials page |
| `/settings/credentials/` | credential names, never values, and every declared provider's key (`provider/<name>`), set or not | set one, generate a webhook secret, set, replace or clear one from its row |
| `/settings/connectors/` | connector packages; with a running engine, the connectors it loaded and the sign-ins under way with their URL and code | sign in |

Runs and sign-ins update as they change. The runs list and the sign-ins follow the engine's event stream and refetch what changed; the run view follows that run's own stream, which sends its record and events, so it needs no other request. A stream that goes quiet for 35 seconds counts as dead; while it's down the page says so, refreshes every two seconds and connects again, and every connect is a new stream that starts over from what is now. The streams sit behind the same access check as every other route.

The run view reads top to bottom as bars, one per step: a tool call from code (titled by its `describe` line), an agent (its text, with its calls as chips that open their input and result), a question, a wait, and a node of `inDependencyOrder` with its own bars inside. Bars are closed but for the latest and failed ones.

Forms for a JSON Schema (workflow parameters, input requests) come from `SchemaForm`: an object of text, numbers, yes or no, options and fixed values gets a field each, with a group of fields for each object in it, such as `{ issue: { repository, number } }`; a fixed value (a JSON Schema `const`, from `z.literal`) is shown, not asked for. Anything else gets a JSON text area. The value is checked against the schema before it's sent. `FixForm` shows the form that sets a missing setting: a provider's key or a credential. A model no provider in the config offers only gets its message: that's a change to the config in git.

## Develop

```bash
pnpm --filter @mesh-flow/ui build   # the server into dist, the page into dist/app
pnpm --filter @mesh-flow/ui test
```

The browser test runs the built page against a stand-in engine, in Chrome, or in the Chromium at `CHROMIUM_PATH`.

The page lives in `app/`, a rooted app laid out in vertical slices (a folder per page with its `_routes.mts`), with rooted's four CSS layers: `index.tokens.css`, `index.theme.css`, the shell's stylesheet and one per component. Its Vite config is a plain one with rooted's CSS loader and route discovery, not `rootedManifest`: the PWA, SEO and pre-rendering that brings are for public sites.
