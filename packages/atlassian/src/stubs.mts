import { hostToolStub } from '@mesh-flow/core'
import { commentOnIssue, getIssue, transitionIssue } from './tools/issue-tools.mts'
import { getPage, searchPages } from './tools/page-tools.mts'
import { searchIssues } from './tools/issue-search-tools.mts'

/**
 * The sandbox's stubs of the host tools: what the connector's functions and tools call. Each runs
 * on the host, through the gateway, with the Atlassian token the sandbox never has.
 */
export const stubs = Object.freeze({
	getIssue: hostToolStub(getIssue),
	commentOnIssue: hostToolStub(commentOnIssue),
	transitionIssue: hostToolStub(transitionIssue),
	searchIssues: hostToolStub(searchIssues),
	getPage: hostToolStub(getPage),
	searchPages: hostToolStub(searchPages),
})
