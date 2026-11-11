import { hostToolStub } from '@mesh-flow/core'
import { cloneRepository, pushBundle } from './tools/git-tools.mts'
import { closeIssue, commentOnIssue, getIssue, labelIssue } from './tools/issue-tools.mts'
import {
	checksOnRef,
	getPullRequest,
	openPullRequest,
	replyToReviewItem,
	reviewActivity,
	showBeingRead,
} from './tools/pull-request-tools.mts'

/**
 * The sandbox's stubs of the host tools: what the connector's functions and tools call. Each runs
 * on the host, through the gateway, with the GitHub token the sandbox never has.
 */
export const stubs = Object.freeze({
	getIssue: hostToolStub(getIssue),
	commentOnIssue: hostToolStub(commentOnIssue),
	labelIssue: hostToolStub(labelIssue),
	closeIssue: hostToolStub(closeIssue),
	cloneRepository: hostToolStub(cloneRepository),
	pushBundle: hostToolStub(pushBundle),
	openPullRequest: hostToolStub(openPullRequest),
	getPullRequest: hostToolStub(getPullRequest),
	reviewActivity: hostToolStub(reviewActivity),
	replyToReviewItem: hostToolStub(replyToReviewItem),
	showBeingRead: hostToolStub(showBeingRead),
	checksOnRef: hostToolStub(checksOnRef),
})
