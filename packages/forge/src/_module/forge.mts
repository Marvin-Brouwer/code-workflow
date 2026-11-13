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
export { defaultAppearWithin, defaultLookEvery, defaultToleratedOutage, looksWithin } from '../review/look-interval.mts'
export { patientLook, type PatientLookOptions } from '../review/patient-look.mts'
export { withScratchFile } from '../scratch-file.mts'
export { Bundle, Sha } from '../checkout/bundle-schemas.mts'
export { gitTools, type GitToolNames, type GitTools } from '../checkout/git-tools.mts'
export { checkoutRepository, type Checkout, type CheckoutOptions, type ClonedBundle } from '../checkout/checkout.mts'
export { branchHeadOf, pushCheckout, type PushBundle, type Pushed } from '../checkout/push.mts'
export { origin, trackingRef } from '../checkout/tracking.mts'
export {
	filesAt,
	filesInPrompt,
	lintSettingsAt,
	templatesAt,
	type ChangeRequestLayout,
	type RepositoryFile,
} from '../describe/repository-files.mts'
export { readBrief, type ChangeBrief } from '../describe/brief.mts'
export { pascalCase, type ChangeRequest, type ChangeRequestRef, type ForgeTerms } from '../describe/change-request.mts'
export {
	changeTextSchema,
	normalizedBody,
	sameText,
	textInPrompt,
	type BasedOn,
	type ChangeContent,
	type ChangeText,
	type ChangeTextLimits,
} from '../describe/change-text.mts'
export { decideOnEdit, type EditDecision } from '../describe/decide-on-edit.mts'
export { describeChange, type DescribeChangeOptions, type DescribeForge } from '../describe/describe-change.mts'
export {
	triageItems,
	triageResult,
	type PlannedChange,
	type ReplyStage,
	type TriageForge,
	type TriageItem,
	type TriageItemsOptions,
} from '../review/triage-items.mts'
export {
	watchReview,
	type CommitChecks,
	type ReviewActivity,
	type ReviewWatch,
	type WatchedRequest,
	type WatchHandlers,
	type WatchOptions,
	type WatchOutcome,
} from '../review/watch-review.mts'
export { BranchName } from '../checkout/branch-name.mts'
