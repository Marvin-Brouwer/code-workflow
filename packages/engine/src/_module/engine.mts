/**
 * The mesh-flow engine: the host process that runs each workflow run in its own sandbox, relays
 * input requests, pauses everything on shutdown and reconciles on start. The `mesh-flow` command
 * runs it; this entry point is for embedding it.
 *
 * @module
 */
export { openAppStore, type AppStore, type AppVersion } from '../apps/app-store.mts'
export { controlClient, ControlError, DeployedApp, DeployOutcome, type ControlClient } from '../control/control-client.mts'
export { AnswerBody, controlApi, engineErrorStatus, StartRunBody, type ControlApiOptions } from '../control/control-api.mts'
export { ShownConnector } from '../control/shown-connector.mts'
export {
	connectorSettingsFileName,
	ConnectorSetting,
	openConnectorSettings,
	PackageName,
	type ConnectorSettings,
} from '../connectors/connector-settings.mts'
export { hostEntry, loadConnectors, type LoadConnectorsOptions, type LoadedConnector } from '../connectors/load-connectors.mts'
export { controlSocketPath, engineAnswers } from '../control/control-socket.mts'
export { engineEventStream, type EngineEventSource } from '../control/engine-event-stream.mts'
export { streamHeartbeat } from '../control/event-stream.mts'
export { runEventStream, type RunEventSource } from '../control/run-event-stream.mts'
export { Engine, type CloseDeadlines, type EngineOptions, type StartRunOptions } from '../engine/engine.mts'
export { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'
export { defaultSandboxLayout, type SandboxLayout } from '../engine/sandbox-layout.mts'
export { SignInState } from '../engine/sign-in-state.mts'
export { RunId } from '../runs/run-id.mts'
export { RunApp, RunRecord, RunStatus } from '../runs/run-record.mts'
export { openRunStore, runDirectory, type LoadedRuns, type RunStore } from '../runs/run-store.mts'
export { gatewayDirectory, openEngineGatewayHome, type EngineGatewayOptions } from '../serve/engine-gateway.mts'
export { serveEngine, type ServedEngine, type ServeEngineOptions } from '../serve/serve-engine.mts'
export {
	listProviders,
	putProvider,
	removeProvider,
	setProviderKey,
	type ListedProvider,
	type ProviderInput,
} from '../settings/providers.mts'
export { handleShutdown, type HandleShutdownOptions, type ShutdownProcess } from '../shutdown/handle-shutdown.mts'
export { uiEntry, type ServedUi, type ServeUi, type ServeUiOptions } from '../ui/ui-host.mts'
