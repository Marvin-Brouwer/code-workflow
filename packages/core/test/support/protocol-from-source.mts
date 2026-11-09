import { register } from 'node:module'

/**
 * Loaded with `node --import` by the engine start test: lets `@mesh-flow/protocol` resolve to its
 * sources, so the test runs without building it. Pi's packages declare a `source` condition without
 * shipping their sources, so `--conditions=source` can't do this.
 */
register('./protocol-resolve-hook.mts', import.meta.url)
