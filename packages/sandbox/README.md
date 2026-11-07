# `@mesh-flow/sandbox`

The sandboxes a mesh-flow run lives in, behind one interface: create one, run commands in it, pause it to disk with its memory and processes, resume it, and clean up what's left after a crash.

Three backends, picked per machine ([design section 3](../../docs/design.md#3-architecture)):

| Backend | Where | Entry point |
|---|---|---|
| E2B | hosted runs, E2B Cloud | `@mesh-flow/sandbox/e2b` |
| microsandbox | locally, with a hypervisor (KVM, Hypervisor.framework, Windows Hypervisor Platform) | `@mesh-flow/sandbox/microsandbox` |
| gVisor | locally on Linux without one, such as CI | `@mesh-flow/sandbox/gvisor` |

The backends are separate entry points, so an engine only loads the SDK it uses.

This package is for the engine. Workflow code never sees it.

## Usage

```ts
import { chooseBackend, PausedSandbox, startInBackground, type SandboxBackend } from '@mesh-flow/sandbox';

const choice = chooseBackend({ hosted: false });
console.log(`sandbox backend: ${choice.backend} (${choice.reason})`);

const backend: SandboxBackend = choice.backend === 'gvisor'
    ? (await import('@mesh-flow/sandbox/gvisor')).gvisorBackend({ directory: '/var/lib/mesh-flow/gvisor' })
    : (await import('@mesh-flow/sandbox/microsandbox')).microsandboxBackend();

const sandbox = await backend.create({
    image: 'node:22-slim',
    cpus: 2,
    memoryMb: 2048,
    egress: { allow: ['registry.npmjs.org'] },
}, signal);

await sandbox.writeFile('/srv/runtime.mjs', runtimeSource, signal);
await startInBackground(sandbox, ['node', '/srv/runtime.mjs'], { signal, logFile: '/var/log/runtime.log' });

// The run waits for a human: keep the paused state in the run record.
const paused = await sandbox.pause(signal);

// Later, maybe after a restart of the engine or the machine:
const resumed = await backend.resume(PausedSandbox.parse(record.paused), signal);
```

On shutdown, pause what's worth keeping and close the backend. `close` aborts calls in flight and destroys every sandbox it still runs, so nothing is left behind:

```ts
await Promise.allSettled(running.map((sandbox) => sandbox.pause(deadline)));
await backend.close(deadline);
```

On start, reconcile: `list` returns every mesh-flow sandbox the backend holds, also ones from a process that died, and `remove` takes away the ones the engine has no record of.

## What every backend does the same

- **Every call takes an `AbortSignal`**, and aborting settles it right away. The microsandbox SDK takes no signals, so its calls are raced against the signal; a command still running is killed, and a sandbox created too late is removed.
- **A pause keeps memory, processes and the stack.** A pending `await` resolves in the same process after a resume. Open connections don't survive a pause, so nothing may hold one across a wait ([design section 5](../../docs/design.md#5-durability)).
- **The id stays the same** across a pause and resume.
- **A pause only resumes on the backend that made it.** Anything else is a `BackendMismatchError`.
- **Egress is deny by default.** `egress.allow` lists host names; an empty list means no network.
- **Commands are argv arrays**, never a shell line. A non-zero exit code is a result, not an error.

## Where they differ

- **Timers across a pause.** E2B stops the guest's monotonic clock, so a `setTimeout` inside the sandbox doesn't count paused time. gVisor's does. Wall-clock waits belong in the engine. `Date.now()` is right after a resume everywhere.
- **E2B** builds sandboxes from templates, not images: `templates` maps each image to one, and the template fixes CPUs and memory. A sandbox runs at most `timeoutMs` (24 hours by default) before E2B pauses it by itself, which limits what an engine that died leaves running.
- **microsandbox** needs TLS interception for hostname egress rules: allowed HTTPS goes through its proxy, with its own CA. Node in the sandbox needs `--use-system-ca` to trust it. A full snapshot is refused while microsandbox manages a running job, which is why `startInBackground` uses `setsid -f` instead.
- **gVisor** needs Linux and root (`runsc: ['sudo', 'runsc']` otherwise), and pulls images from Docker Hub itself, no Docker needed. Its sandboxes have no network; when hosts are allowed, a proxy on the host tunnels to those only, and the sandbox gets `HTTPS_PROXY` pointing at a forwarder that runs as its init. So only tools that honour `HTTPS_PROXY` get out, and the image needs `node`. A pause writes all memory to disk before it returns: under a second on a fast disk, seconds on a slow one.

## Tests

```bash
pnpm --filter @mesh-flow/sandbox test
```

Unit tests (`*.test.mts`) and functional tests (`*.spec.mts`) run anywhere. The gVisor backend runs against a fake `runsc` there, including the check that `close` finishes while a command never does.

The conformance suite in [`test/conformance`](test/conformance) runs the checks from the pause POCs against real backends: a pending `await` survives a pause in the same process, memory and stack; egress reaches allowed hosts only; `list`, `remove` and `close` leave nothing behind. It needs the backend on the machine, so it only runs when asked:

```bash
MESH_FLOW_SANDBOX_TESTS=gvisor RUNSC='sudo runsc' pnpm --filter @mesh-flow/sandbox test
MESH_FLOW_SANDBOX_TESTS=microsandbox pnpm --filter @mesh-flow/sandbox test
MESH_FLOW_SANDBOX_TESTS=e2b E2B_API_KEY=... MESH_FLOW_E2B_TEMPLATE=... pnpm --filter @mesh-flow/sandbox test
```

## Known gaps

- **The host to sandbox channel** for the workflow runtime and tool calls isn't here yet. It comes with the engine and the gateway ([gateway-tool-calls.md](../../docs/plans/gateway-tool-calls.md)).
- **Egress to the gateway** on microsandbox by IP rule instead of hostname is unverified ([open question 11](../../docs/design.md#open-questions)).
- **microsandbox on native Windows** is untried ([open question 12](../../docs/design.md#open-questions)).
- **Running agent shell commands as a separate, unprivileged user** ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)) needs a `user` on `exec`. The backends can all do it, but what a user is differs per backend (a name on E2B and microsandbox, a uid for runsc), so it waits for the engine that decides it.
- **`create` isn't idempotent**: every call makes a new sandbox. Runs own their sandbox, and reconciliation removes what a crash left behind.
