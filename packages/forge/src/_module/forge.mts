/**
 * What the connectors of code forges share on the sandbox's side: git for a checkout, the markers
 * that find a connector's own posts, the pieces `describe` and `review` are made of, and the
 * patient looks of a watch. Workflows use a connector, such as `@mesh-flow/github`; this package is
 * for connectors.
 *
 * @module
 */
export { capped } from '../describe/capped.mts'
export { fenced } from '../describe/fenced.mts'
export { committer, localGit } from '../checkout/local-git.mts'
export { commentMarker, isMarked, markerStart, markerValue } from '../markers.mts'
export { defaultLookEvery, defaultToleratedOutage, looksWithin } from '../review/look-interval.mts'
export { patientLook, type PatientLookOptions } from '../review/patient-look.mts'
export { withScratchFile } from '../scratch-file.mts'
