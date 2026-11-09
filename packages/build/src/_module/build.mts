/**
 * Builds a mesh-flow app into a folder the engine can deploy: bundled into one file, its native
 * dependencies installed for the sandbox's platform, and described, so the sandbox only runs `node`.
 *
 * @module
 */
export { buildApp, type BuildAppOptions } from '../build-app.mts'
