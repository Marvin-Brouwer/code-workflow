/**
 * The mesh-flow engine: the host process that runs each workflow run in its own sandbox, relays
 * input requests, pauses everything on shutdown and reconciles on start. The `mesh-flow` command
 * runs it; this entry point is for embedding it.
 *
 * @module
 */
export { ControlClient, ControlError } from '../control/control-client.mts'
export { controlApi } from '../control/control-api.mts'
export { controlSocketPath } from '../control/control-socket.mts'
export { Engine, type CloseOptions, type EngineOptions, type StartRunOptions } from '../engine/engine.mts'
export { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'
export { defaultSandboxLayout, type SandboxLayout } from '../engine/sandbox-layout.mts'
export { RunId } from '../runs/run-id.mts'
export { RunRecord, RunSource, RunStatus } from '../runs/run-record.mts'
export { RunStore, type LoadedRuns } from '../runs/run-store.mts'
export { serveEngine, type ServedEngine, type ServeEngineOptions } from '../serve/serve-engine.mts'
export { handleShutdown, type HandleShutdownOptions, type ShutdownProcess } from '../shutdown/handle-shutdown.mts'
export { WorkflowConfig, workflowConfigFile } from '../workflow/workflow-config.mts'
