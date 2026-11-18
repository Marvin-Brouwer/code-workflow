# `@mesh-flow/ui`

The mesh-flow UI: the runs and their requests, starting a workflow from its button, and the settings (providers, keys and credentials), in a browser on the machine the engine runs on. It's a wireframe on purpose: plain elements, borders, greys. The design comes later.

The page is a [rooted](https://github.com/rooted-org/rooted) app. Its server, which `mesh-flow ui` loads, serves the page and an API over the engine's control socket and the home's settings, on 127.0.0.1 only.

## Use

Install it where `mesh-flow` runs, the same as a connector, and open it:

```bash
pnpm add @mesh-flow/ui
mesh-flow ui            # serves it on a free port and opens the browser
mesh-flow ui --port 4800 --no-open
```

The address it prints has a token that lets one browser in. Settings work without a running engine; runs and apps need `mesh-flow serve`. Ctrl+C stops it.

To serve it from code of your own:

```ts
import { serveUi } from '@mesh-flow/ui/server'

const stopping = new AbortController()
const served = await serveUi({
	home: '/home/me/.local/share/mesh-flow',
	keychain: true,
	port: 0,
	open: false,
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
| `?token=` is the printed token; it's swapped for an `HttpOnly`, `SameSite=Strict` cookie and dropped from the address bar | 401 |
| every other request has that cookie | 401 |
| a change is sent as JSON, which a form on another site can't send without asking first | 415 |

This is the local way in. Hosted (roadmap step 7), a sign-in per user takes its place in front of the same routes; the page only knows it talks to `/api` with a cookie.

## The API

| Route | Does |
|---|---|
| `GET /api/engine/status` | `{ running }`: whether an engine answers on the home's socket |
| `/api/engine/runs`, `/runs/:run`, `/runs/:run/events`, `/runs/:run/answers/:request`, `/runs/:run/stop`, `/resume`, `/restart` | the engine's control API, the same calls as the CLI; 503 when no engine runs |
| `GET /api/engine/sign-ins`, `POST /api/engine/sign-ins/:connector` | sign-ins under way, and waiting for one |
| `GET /api/engine/apps`, `GET /api/engine/apps/:name/missing` | deployed apps, and what one still needs before it can run |
| `/api/settings/providers`, `/providers/:name`, `/providers/:name/key`, `/provider-order`, `/provider-kinds` | model providers and their keys, as `mesh-flow provider` |
| `/api/settings/credentials`, `/credentials/:name` | credential names, setting and removing them; values never come back |
| `GET /api/settings/connectors` | the connector packages the engine loads |

Deploying isn't in it: that stays with the CLI and CI.

## Develop

```bash
pnpm --filter @mesh-flow/ui build   # the server into dist, the page into dist/app
pnpm --filter @mesh-flow/ui test
```

The page lives in `app/`, a rooted app laid out in vertical slices (a folder per page with its `_routes.mts`), with rooted's four CSS layers: `index.tokens.css`, `index.theme.css`, the shell's stylesheet and one per component. Its Vite config is a plain one with rooted's CSS loader and route discovery, not `rootedManifest`: the PWA, SEO and pre-rendering that brings are for public sites.
