# `@mesh-flow/sandbox`

The sandboxes a mesh-flow run lives in, behind one interface: create one, run commands in it, pause it to disk with its memory and processes, resume it, and clean up what's left after a crash.

Three backends, picked per machine ([design section 3](../../docs/design.md#3-architecture)):

| Backend | Where | Entry point |
|---|---|---|
| E2B | hosted runs, E2B Cloud | `@mesh-flow/sandbox/e2b` |
| microsandbox | locally, with a hypervisor (KVM, Windows Hypervisor Platform, Hypervisor.framework on Apple Silicon) | `@mesh-flow/sandbox/microsandbox` |
| gVisor | locally on Linux without one, such as CI | `@mesh-flow/sandbox/gvisor` |

The backends are separate entry points, so an engine only loads the SDK it uses.

This package is for the engine. Workflow code never sees it.

## Usage

### Pick a backend

`chooseBackend` applies the rule above to this machine and says why it chose what it did. Load only the backend it names:

```ts
import { chooseBackend, type SandboxBackend } from '@mesh-flow/sandbox'

const choice = chooseBackend({ hosted: false })
console.log(`sandbox backend: ${choice.backend} (${choice.reason})`)
if (choice.warning) console.warn(choice.warning)

const backend: SandboxBackend =
	choice.backend === 'gvisor'
		? (await import('@mesh-flow/sandbox/gvisor')).gvisorBackend({ directory: '/var/lib/mesh-flow/gvisor' })
		: (await import('@mesh-flow/sandbox/microsandbox')).microsandboxBackend()
```

Hosted, E2B takes an API key from the engine's credential store and a template per image. [Setting up E2B](#setting-up-e2b) says how to get both:

```ts
import { e2bBackend } from '@mesh-flow/sandbox/e2b'

const backend = e2bBackend({ apiKey, templates: { 'node:26-slim': 'mesh-flow-node-22' } })
```

### Create a sandbox and run commands

`sandbox.startInBackground` starts a process that outlives the call and survives a pause, such as the workflow runtime. On E2B and microsandbox it needs `setsid` (util-linux) in the image.

```ts
const sandbox = await backend.create(
	{
		image: 'node:26-slim',
		cpus: 2,
		memoryMb: 2048,
		egress: { allow: ['registry.npmjs.org'] },
	},
	signal,
)

const result = await sandbox.exec(['npm', 'ci'], { signal, cwd: '/work' })
if (result.exitCode !== 0) throw new Error(result.stderr)

await sandbox.writeFile('/srv/runtime.mjs', runtimeSource, signal)
await sandbox.startInBackground(['node', '/srv/runtime.mjs'], { signal, logFile: '/var/log/runtime.log' })
```

### Pause and resume

A run that waits for a human pauses its sandbox and keeps the paused state in the run record. It is plain JSON, and `PausedSandbox` parses it back:

```ts
import { PausedSandbox } from '@mesh-flow/sandbox'

const paused = await sandbox.pause(signal)
await saveRunRecord({ ...record, paused })

// Later, maybe after a restart of the engine or the machine:
const resumed = await backend.resume(PausedSandbox.parse(record.paused), signal)
```

### Shut down and reconcile

On shutdown, pause what's worth keeping and close the backend. `close` aborts calls in flight, destroys every sandbox it still runs and waits for cleanup still going, so nothing is left behind. The deadline bounds all of it:

```ts
const deadline = AbortSignal.timeout(30_000)
await Promise.allSettled(running.map((sandbox) => sandbox.pause(deadline)))
await backend.close(deadline)
```

On start, reconcile: `list` returns every mesh-flow sandbox the backend holds, also ones from a process that died, and `remove` takes away the ones the engine has no record of:

```ts
for (const held of await backend.list(signal)) {
	if (!knownSandboxIds.has(held.id)) await backend.remove(held.id, signal)
}
```

`abortable` bounds work that takes no signal, or may ignore it, by a signal of yours. The work keeps going, but the caller moves on when the signal aborts. Pass `discard` to clean up a value that arrives after the abort, such as a sandbox created too late:

```ts
import { abortable } from '@mesh-flow/sandbox'

const deadline = AbortSignal.timeout(30_000)
const paused = await abortable(sandbox.pause(deadline), deadline)

// `createVm` stands for any SDK call that takes no signal and makes something that mustn't leak.
const createVm = (): Promise<{ kill(): Promise<void> }> => sdk.vms.create({ image: 'node:26-slim' })
const vm = await abortable(createVm(), deadline, (late) => late.kill())
```

## Setting up E2B

The E2B backend needs two things: an API key and a template for each image a spec names.

### API key

1. Sign up or sign in at [e2b.dev](https://e2b.dev).
2. In the [API Keys tab](https://e2b.dev/dashboard?tab=keys) of the dashboard, create a key for the team the sandboxes should run in. It starts with `e2b_`.
3. Store it in the engine's credential store. The engine passes it to `e2bBackend` as `apiKey` and keeps it on the host: it never goes into a sandbox, an env var or a file in the repository.

The conformance suite reads it from `E2B_API_KEY`, as the E2B SDK does, because it runs outside the engine.

### Templates

E2B starts sandboxes from templates, not from images. Build one per image with the E2B SDK's `Template` builder; the build also fixes CPUs and memory:

```ts
import { defaultBuildLogger, Template } from 'e2b'

const template = Template().fromImage('node:26-slim')

await Template.build(template, 'mesh-flow-node-22', {
	apiKey,
	cpuCount: 2,
	memoryMB: 2048,
	onBuildLogs: defaultBuildLogger(),
})
```

Then map the image to the template's name in `templates`: `{ 'node:26-slim': 'mesh-flow-node-22' }`. A spec with an image that has no template is an error. `Template()` also starts from a Dockerfile or another template; see the [E2B docs](https://e2b.dev/docs).

### Self-hosted E2B

A [self-hosted E2B](https://github.com/e2b-dev/infra) deployment works the same way: it also needs an API key and templates, only both come from your own deployment. Create the key there, build the templates against it by passing its `domain` to `Template.build`, and pass the same `domain` to the backend:

```ts
const backend = e2bBackend({ apiKey, domain: 'e2b.internal.example', templates: { 'node:26-slim': 'mesh-flow-node-22' } })
```

## What every backend does the same

- **Every call takes an `AbortSignal`**, and aborting settles it right away. The microsandbox SDK takes no signals, so its calls are raced against the signal; a command still running is killed, and a sandbox created too late is removed.
- **A pause keeps memory, processes and the stack.** A pending `await` resolves in the same process after a resume. Open connections don't survive a pause, so nothing may hold one across a wait ([design section 5](../../docs/design.md#5-durability)).
- **The id stays the same** across a pause and resume. A sandbox runs once: resuming one that already runs, or is being resumed, is refused.
- **A pause only resumes on the backend that made it.** Anything else is a `BackendMismatchError`.
- **Egress is deny by default.** `egress.allow` lists lowercase host names, matched exactly; an empty list means no network. Wildcards, ports, IP addresses and CIDR ranges are refused, because the backends can't all enforce them the same way.
- **Input is checked** with zod: the spec on `create` and the paused sandbox on `resume`, so a bad host name fails there and not inside a backend.
- **Commands are argv arrays**, never a shell line. A non-zero exit code is a result, not an error.

## Where they differ

- **Timers across a pause.** E2B stops the guest's monotonic clock, so a `setTimeout` inside the sandbox doesn't count paused time. gVisor's does. Wall-clock waits belong in the engine. `Date.now()` is right after a resume everywhere.
- **E2B** builds sandboxes from templates, not images: `templates` maps each image to one, and the template fixes CPUs and memory. A sandbox runs at most `timeoutMs` (24 hours by default) before E2B pauses it by itself, which limits what an engine that died leaves running.
- **microsandbox** needs TLS interception for hostname egress rules: allowed HTTPS goes through its proxy, with its own CA. microsandbox adds that CA to the guest's trust store and sets the usual CA variables (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`), so npm, curl and dotnet trust it with no settings, as the conformance suite shows. A full snapshot is refused while microsandbox manages a running job, which is why `startInBackground` uses `setsid -f` instead.
- **gVisor** needs Linux and root (`runsc: ['sudo', 'runsc']` otherwise). A pause writes all memory to disk before it returns: under a second on a fast disk, seconds on a slow one. Processes started with `runsc exec` don't survive a checkpoint, only the container's init and its children, so the init is a small shell that starts each `startInBackground` process as its own child. Its options:
  - `directory`: images, bundles, checkpoints and runsc's state. Keep it across restarts.
  - `platform`: runsc's platform, `systrap` by default; `kvm` is faster where `/dev/kvm` exists.
  - `upstreamProxy`: an HTTP proxy between the machine and the internet, as `http://host:port`.

  It pulls images from Docker Hub itself, no Docker needed: each layer is checked against its digest, and the image's `Env` and `WorkingDir` apply. Other registries aren't supported yet. The unpacked files belong to the user the engine runs as, so with `sudo runsc` setuid bits are lost; root in the sandbox gets Docker's default capabilities and can still write everywhere.

  Its sandboxes have no network. When hosts are allowed, a proxy on the host tunnels to those only, on port 443, and the sandbox gets `HTTPS_PROXY` pointing at a forwarder that runs as its init. So only tools that honour `HTTPS_PROXY` get out, and the image needs Node 22.3 or later: without it, a create that allows hosts fails. `create` returns once the forwarder listens, so the first command can use it.

## Tests

```bash
pnpm --filter @mesh-flow/sandbox test
```

Unit tests (`*.test.mts`) and functional tests (`*.spec.mts`) run anywhere, except the conformance suite below. The gVisor backend runs against a fake `runsc` there, including the checks that `close` finishes while a command or a create never does.

The conformance suite in [`test/conformance`](test/conformance) runs the checks from the pause POCs against real backends: a pending `await` survives a pause in the same process, memory and stack; egress reaches allowed hosts only; npm and NuGet install from an allowed registry with no proxy or certificate settings; `list`, `remove` and `close` leave nothing behind. The package checks also need `node:26-bookworm`, and reach `registry.npmjs.org`, `builds.dotnet.microsoft.com` (for the SDK) and `api.nuget.org`. It needs the backend on the machine, so it only runs when asked:

```bash
MESH_FLOW_SANDBOX_TESTS=gvisor RUNSC="sudo $(command -v runsc)" pnpm --filter @mesh-flow/sandbox test
MESH_FLOW_SANDBOX_TESTS=microsandbox pnpm --filter @mesh-flow/sandbox test
MESH_FLOW_SANDBOX_TESTS=e2b E2B_API_KEY=... MESH_FLOW_E2B_TEMPLATE=... pnpm --filter @mesh-flow/sandbox test
```

The full path to `runsc` matters where sudo has its own `PATH` (`secure_path`), as on NixOS.

CI runs the same suite on every pull request ([`sandbox.yml`](../../.github/workflows/sandbox.yml)): gVisor and microsandbox on Linux, microsandbox on Windows, and E2B on both when the `E2B_API_KEY` secret is set.

## Known gaps

- **The host to sandbox channel** isn't part of this package. The workflow runtime's mailbox is in [`@mesh-flow/engine`](../engine/README.md#the-mailbox), on top of `exec` and `writeFile`; tool calls come with the gateway ([gateway-tool-calls.md](../../docs/plans/gateway-tool-calls.md)).
- **Egress to the gateway** on microsandbox by IP rule instead of hostname is unverified ([open question 11](../../docs/design.md#open-questions)).
- **microsandbox on native Windows** passes the conformance suite in CI, but is untried on a developer machine ([open question 12](../../docs/design.md#open-questions)).
- **macOS** is untested: `chooseBackend` picks microsandbox on Apple Silicon with a warning saying so, and throws on an Intel Mac, where microsandbox has no build and gVisor doesn't run.
- **Running agent shell commands as a separate, unprivileged user** ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)) needs a `user` on `exec`. The backends can all do it, but what a user is differs per backend (a name on E2B and microsandbox, a uid for runsc), so it waits for the engine that decides it.
- **DNS is a way out on E2B and microsandbox.** For hostname rules to work, both let the sandbox reach a DNS server whenever a host is allowed, and a DNS query can carry data out. gVisor resolves names on the host, so it doesn't have this gap.
- **An aborted create on E2B** can still make a sandbox, when E2B received the request before the abort. It carries the mesh-flow metadata, so `list` finds it and reconciliation removes it.
- **`create` isn't idempotent**: every call makes a new sandbox. Runs own their sandbox, and reconciliation removes what a crash left behind.
