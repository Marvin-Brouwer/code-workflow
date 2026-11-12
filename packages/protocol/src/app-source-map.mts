/**
 * The field that marks the source map `mesh-flow build` writes next to an app's bundle. Its files
 * are named relative to the app's repository, and loops are keyed through it. Other source maps,
 * such as the ones packages ship, are left alone.
 */
export const appSourceMapMarker = 'x_mesh_flow_app'
