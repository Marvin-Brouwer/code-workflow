import { goneStatus, notFound, unauthorized } from '@mesh-flow/code-repository/host'

/** GitLab's answer to a request that wasn't served, with its status, so a caller can tell a 404 from the rest. */
export class GitlabRequestError extends Error {
	override readonly name = 'GitlabRequestError'
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.status = status
	}
}

/** Whether GitLab answered that what was asked for is gone, such as a note deleted since. */
export function isGone(error: unknown): boolean {
	return error instanceof GitlabRequestError && (error.status === notFound || error.status === goneStatus)
}

/** Whether GitLab refused the token: one that's wrong, expired or revoked. */
export function refusedToken(error: unknown): boolean {
	return error instanceof GitlabRequestError && error.status === unauthorized
}
