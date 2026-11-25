import { poll, wait } from '@mesh-flow/core'
import type { Duration } from '@mesh-flow/duration'
import { lookBudget } from './look-budget.mts'
import { defaultAppearWithin, defaultLookEvery, defaultToleratedOutage } from './look-interval.mts'
import { patientLook } from './patient-look.mts'
import type { CommitChecks } from './watch-review.mts'

/** What `untilCompleted` takes: how often to look, and for how long. */
export interface UntilCompletedOptions {
	/** How long to wait between looks while the checks run. Default: 10 seconds. */
	readonly every?: Duration | undefined
	/** How long to wait for the first check to appear on a fresh commit before taking it for one without checks. Default: 10 minutes. */
	readonly appearWithin?: Duration | undefined
	/** How long looks may keep failing before the last error is thrown. Counted in looks `every` apart. Default: 10 minutes. */
	readonly toleratedOutage?: Duration | undefined
}

/**
 * Looks at a commit's checks, `every` apart, until they completed, and resolves to the ones that
 * failed. Checks take a while to appear after a push, so a commit without any is looked at again
 * until `appearWithin` has passed, and counts as passed after that. A look that fails is tried
 * again on the next one, for up to `toleratedOutage`. It is what `checksPass` and
 * `pipelinePasses` are made of; each connector only says how it looks. The looks and the waits
 * between them are `poll`s for `description`, so the run view shows one waiting bar.
 */
export async function untilCompleted<Failure>(
	description: string,
	lookAt: () => Promise<CommitChecks<Failure>>,
	options: UntilCompletedOptions = {},
): Promise<readonly Failure[]> {
	const every = options.every ?? defaultLookEvery
	const checksMayAppear = lookBudget(options.appearWithin ?? defaultAppearWithin, every)
	const look = patientLook({ description, every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	for (;;) {
		const checks = await look(lookAt)
		if (checks.status === 'completed' || (checks.status === 'none' && !checksMayAppear())) return checks.failures
		await poll(description, () => wait(every))
	}
}
