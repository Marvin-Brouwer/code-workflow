import type { ClosesIssue } from './merge-request-text.mts'

/** The `closes` field of a host call for `issue`, when there is one. */
export function closingField(issue: ClosesIssue | undefined): { closes?: string } {
	return issue === undefined ? {} : { closes: issue.key }
}
