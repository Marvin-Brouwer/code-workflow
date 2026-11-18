/**
 * The UI's server, which `mesh-flow ui` loads from this package: the page, and its API over the
 * engine's control socket and the home's settings, on 127.0.0.1 only.
 *
 * @module
 */
export { serveUi, serveUiFrom } from '../server/serve-ui.mts'
export { uiApp, type UiAppOptions } from '../server/ui-app.mts'
