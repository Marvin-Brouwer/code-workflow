import { hostToolStub } from '@mesh-flow/core'
import { cloneRepository, pushBundle } from './tools/git-tools.mts'
import {
	findMergeRequest,
	getMergeRequest,
	openMergeRequest,
	replyToReviewItem,
	reviewActivity,
	showBeingRead,
	updateMergeRequest,
} from './tools/merge-request-tools.mts'
import { pipelineOnCommit, pipelinePackages } from './tools/pipeline-tools.mts'
import { searchRepositories } from './tools/search-tools.mts'

/**
 * The sandbox's stubs of the host tools: what the connector's functions and tools call. Each runs
 * on the host, through the gateway, with the GitLab token the sandbox never has.
 */
export const stubs = Object.freeze({
	cloneRepository: hostToolStub(cloneRepository),
	pushBundle: hostToolStub(pushBundle),
	searchRepositories: hostToolStub(searchRepositories),
	openMergeRequest: hostToolStub(openMergeRequest),
	updateMergeRequest: hostToolStub(updateMergeRequest),
	findMergeRequest: hostToolStub(findMergeRequest),
	getMergeRequest: hostToolStub(getMergeRequest),
	reviewActivity: hostToolStub(reviewActivity),
	replyToReviewItem: hostToolStub(replyToReviewItem),
	showBeingRead: hostToolStub(showBeingRead),
	pipelineOnCommit: hostToolStub(pipelineOnCommit),
	pipelinePackages: hostToolStub(pipelinePackages),
})
