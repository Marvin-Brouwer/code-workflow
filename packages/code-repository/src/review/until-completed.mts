import { wait, type WaitSpec } from '@mesh-flow/core'
import { defaultAppearWithin, defaultLookEvery, defaultToleratedOutage, looksWithin } from './look-interval.mts'
import { patientLook } from './patient-look.mts'
import type { CommitChecks } from './watch-review.mts'

/** What `untilCompleted` takes: how often to look, and for how long. */
export interface UntilCompletedOptions {
	/** How long to wait between looks while the checks run. Default: 10 seconds. */
	readonly every?: WaitSpec | undefined
	/** How long to wait for the first check to appear on a fresh commit before taking it for one without checks. Default: 10 minutes. */
	readonly appearWithin?: WaitSpec | undefined
	/** How long looks may keep failing before the last error is thrown. Counted in looks. Default: 10 minutes. */
	readonly toleratedOutage?: WaitSpec | undefined
}

/**
 * Looks at a commit's checks, `every` apart, until they completed, and resolves to the ones that
 * failed. Checks take a while to appear after a push, so a commit without any is looked at again
 * until `appearWithin` has passed, and counts as passed after that. A look that fails is tried
 * again on the next one, for up to `toleratedOutage`. It is what `checksPass` and
 * `pipelinePasses` are made of; each connector only says how it looks.
 */
export async function untilCompleted<Failure>(
	lookAt: () => Promise<CommitChecks<Failure>>,
	options: UntilCompletedOptions = {},
): Promise<readonly Failure[]> {
	const every = options.every ?? defaultLookEvery
	const looksForChecksToAppear = looksWithin(options.appearWithin ?? defaultAppearWithin, every)
	const look = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	let looksWithoutChecks = 0
	for (;;) {
		const checks = await look(lookAt)
		if (checks.status === 'none') looksWithoutChecks++
		if (checks.status === 'completed' || (checks.status === 'none' && looksWithoutChecks > looksForChecksToAppear)) return checks.failures
		await wait(every)
	}
}
