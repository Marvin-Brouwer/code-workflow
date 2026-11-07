/**
 * The sandboxes a mesh-flow run lives in, behind one interface, and the rule that picks one.
 * The backends are separate entry points: `@mesh-flow/sandbox/e2b`, `/microsandbox` and `/gvisor`.
 *
 * @module
 */
export { chooseBackend, type BackendChoice, type ChooseBackendOptions } from './choose-backend.ts';
export { detectHost, type Host, type KvmAccess } from './host.ts';
export { assertPausedBy, BackendMismatchError, BackendName, PausedSandbox } from './paused-sandbox.ts';
export type { HeldSandbox, SandboxBackend } from './sandbox-backend.ts';
export { EgressPolicy, SandboxSpec } from './sandbox-spec.ts';
export type { Command, ExecOptions, ExecResult, Sandbox } from './sandbox.ts';
export { startInBackground, type StartOptions } from './start-in-background.ts';
