import type { IssueRef } from '../issue/issue.mts'

/** How a pull request in `repository` names `issue` to close it: `#7` in the same repository, `owner/name#7` in another. */
export function closingReference(issue: IssueRef, repository: string): string {
	return issue.repository === repository ? `#${String(issue.number)}` : `${issue.repository}#${String(issue.number)}`
}

/** The `closes` field of a host call for `issue`, when there is one. */
export function closingField(issue: IssueRef | undefined, repository: string): { closes?: string } {
	return issue === undefined ? {} : { closes: closingReference(issue, repository) }
}
