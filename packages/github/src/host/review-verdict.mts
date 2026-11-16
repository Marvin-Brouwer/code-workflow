import type { ReviewItem } from '../tools/pull-request-tools.mts'

/** A review's verdict as GitHub states it, in the words {@link ReviewItem} uses. */
const verdicts: Record<string, ReviewItem['verdict']> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	COMMENTED: 'commented',
	DISMISSED: 'dismissed',
}

/** The verdict of a review in GitHub's state, such as `CHANGES_REQUESTED`; none for a pending one. */
function verdictOf(state: string): ReviewItem['verdict'] {
	return Object.hasOwn(verdicts, state) ? verdicts[state] : undefined
}

/** `{ verdict }` for a review in GitHub's state `state`, or nothing for one without a verdict. */
export function verdictField(state: string): { readonly verdict?: NonNullable<ReviewItem['verdict']> } {
	const verdict = verdictOf(state)
	return verdict === undefined ? {} : { verdict }
}
