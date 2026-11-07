/**
 * The sandboxes a mesh-flow run lives in, behind one interface, and the rule that picks one.
 * The backends are separate entry points: `@mesh-flow/sandbox/e2b`, `/microsandbox` and `/gvisor`.
 *
 * @module
 */
export { assertPausedBy, BackendMismatchError } from '../backend-mismatch-error.mts'
export { BackendName } from '../backend-name.mts'
export { chooseBackend, type BackendChoice, type ChooseBackendOptions } from '../choose-backend.mts'
export { detectHost, type Host, type KvmAccess } from '../host.mts'
export { PausedSandbox } from '../paused-sandbox.mts'
export type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
export { allowsEgress, EgressHost, EgressPolicy, SandboxSpec } from '../sandbox-spec.mts'
export type { Command, ExecOptions, ExecResult, Sandbox } from '../sandbox.mts'
export { startInBackground, type StartInBackgroundOptions } from '../start-in-background.mts'
