/**
 * The sandboxes a mesh-flow run lives in, behind one interface, and the rule that picks one.
 * The backends are separate entry points: `@mesh-flow/sandbox/e2b`, `/microsandbox` and `/gvisor`.
 *
 * @module
 */
export { chooseBackend, type BackendChoice, type ChooseBackendOptions } from '../choose-backend.mts'
export { detectHost, type Host, type KvmAccess } from '../host.mts'
export { assertPausedBy, BackendMismatchError, BackendName, PausedSandbox } from '../paused-sandbox.mts'
export type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
export { EgressPolicy, SandboxSpec } from '../sandbox-spec.mts'
export type { Command, ExecOptions, ExecResult, Sandbox } from '../sandbox.mts'
export { startInBackground, type StartOptions } from '../start-in-background.mts'
