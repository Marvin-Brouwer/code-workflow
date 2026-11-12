import { normalizedBody } from '../pull-request/pull-request-text.mts'
import { Sha } from '../tools/git-tools.mts'
import { markerValue } from '../tools/issue-tools.mts'
import { runIdLine, signed, unsigned, withoutRunId } from './signature.mts'

/** The name of the marker on a description this package wrote: `described:<sha>`, the commit it was written for. */
const describedKeyName = 'described'

/** A pull request's description without the connector's footer, and the commit it was written for, by its marker, when there is one. */
export function descriptionOf(body: string | null | undefined): { description: string; describedSha?: string } {
	if (body === null || body === undefined) return { description: '' }
	const sha = markerValue(body, describedKeyName)
	// A marker someone edited is no marker: the commit it names is unknown.
	return { description: unsigned(body), ...(sha !== undefined && Sha.safeParse(sha).success ? { describedSha: sha } : {}) }
}

/** What a description is signed with besides the run id: the commit it describes and the issue it closes. */
export interface DescriptionNotes {
	readonly describedSha?: string | undefined
	readonly closes?: string | undefined
}

/** A description as the connector writes it: signed, with `Fixes` next to the run id, and marked with the commit it describes. */
export function signedDescription(body: string, runId: string, { describedSha, closes }: DescriptionNotes): string {
	// So a text that didn't change signs the same.
	return signed(
		normalizedBody(body),
		runId,
		describedSha === undefined ? [] : [`${describedKeyName}:${describedSha}`],
		closes === undefined ? [] : [fixesNote(closes)],
	)
}

/**
 * Whether a body GitHub has is the signed one, whichever line breaks its editor saved it with and
 * whichever run signed it: a run that starts over doesn't rewrite a text only for its run id.
 */
export function sameBody(stored: string | null | undefined, signedBody: string): boolean {
	return withoutRunId(stored ?? '') === withoutRunId(signedBody)
}

/** The note next to the run id that has GitHub close an issue, such as `Fixes #7`. */
function fixesNote(closes: string): string {
	return `Fixes ${closes}`
}

/**
 * Whether a description's footer already closes the issue: the run id line of the last footer ends
 * in its note, so `Fixes #70` isn't `Fixes #7`, and a sentence of a person's isn't the footer.
 */
export function footerCloses(body: string | null | undefined, closes: string): boolean {
	return runIdLine(body ?? '')?.endsWith(` ${fixesNote(closes)}`) ?? false
}
