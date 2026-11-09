import { register } from 'node:module'

/**
 * Loaded with `node --import` by the tests that start the engine in a process of its own: lets the
 * `@mesh-flow/*` packages resolve to their sources, so the test runs without building them. Pi's
 * packages, under the gateway, declare a `source` condition without shipping their sources, so
 * `--conditions=source` can't do this.
 */
register('./workspace-resolve-hook.mts', import.meta.url)
