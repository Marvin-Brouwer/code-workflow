import path from 'node:path'
import { serveEngine } from '../../src/serve/serve-engine.mts'
import { handleShutdown } from '../../src/shutdown/handle-shutdown.mts'
import { hostBackend, hostSandboxLayout } from './host-backend.mts'

/**
 * `mesh-flow serve` on the host backend, for tests that need the engine in a process of its own:
 * `node serve-on-host.mts <home>`. Prints `ready` once it serves.
 */
const home = process.argv[2]
if (!home) throw new Error('Pass the home directory.')
const backend = hostBackend(path.join(home, 'sandboxes'))
const served = await serveEngine({ home, backend, layout: hostSandboxLayout, abortSignal: AbortSignal.timeout(30_000) })
handleShutdown({ shutdown: (deadlines) => served.close(deadlines), pauseTimeoutMs: 5_000, closeTimeoutMs: 5_000 })
console.log('ready')
