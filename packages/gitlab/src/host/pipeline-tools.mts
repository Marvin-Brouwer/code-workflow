import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { pipelineOnCommit, pipelinePackages, type JobFailure, type PipelineStatus } from '../tools/merge-request-tools.mts'
import { isGone, projectSegment, type ApiClient, type GitlabClient } from './api.mts'

const ApiPipeline = z.object({ id: z.int(), sha: z.string(), status: z.string(), web_url: z.url() })
type ApiPipeline = z.infer<typeof ApiPipeline>

const ApiCommit = z.object({ parent_ids: z.array(z.string()) })

const ApiJob = z.object({
	name: z.string(),
	stage: z.string(),
	status: z.string(),
	web_url: z.url().optional(),
	failure_reason: z.string().nullable().optional(),
	allow_failure: z.boolean().optional(),
})

const ApiPackage = z.object({
	name: z.string(),
	version: z.string(),
	status: z.string().optional(),
	pipeline: z.object({ id: z.int() }).nullable().optional(),
	pipelines: z
		.array(z.object({ id: z.int() }))
		.nullable()
		.optional(),
})

/**
 * Pipeline states after which nothing more runs on its own. A pipeline waiting on a manual job counts:
 * nothing runs until someone starts it.
 */
const doneStates = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])

/** Pipeline states whose jobs are worth listing as failures. */
const failedStates = new Set(['failed', 'canceled'])

/** A commit id GitLab hasn't filled in, as on a merge request it is still preparing. */
const noCommit = /^0+$/

/** How many of a merge request's latest pipelines are looked at for a merged results pipeline of its head. */
const mergedResultsCandidates = 5

/**
 * The latest pipeline of commit `sha`, or, for a merge request, its latest merged results pipeline
 * of `sha`: one on a commit GitLab made by merging `sha` into the target, which has `sha` as a parent.
 */
async function latestPipeline(
	client: GitlabClient,
	project: string,
	{ sha, ref, mergeRequest }: { readonly sha: string; readonly ref?: string | undefined; readonly mergeRequest?: number | undefined },
): Promise<ApiPipeline | undefined> {
	const { items } = await client.firstPage(`${project}/pipelines`, ApiPipeline, 1, { sha, ref, order_by: 'id', sort: 'desc' })
	if (items[0] !== undefined || mergeRequest === undefined) return items[0]
	const ofRequest = await client.firstPage(
		`${project}/merge_requests/${String(mergeRequest)}/pipelines`,
		ApiPipeline,
		mergedResultsCandidates,
	)
	for (const candidate of ofRequest.items) {
		if (candidate.sha === sha) return candidate
		// GitLab may have cleaned up the merge commit of an old pipeline: that one isn't the head's.
		const commit = await client.request('GET', `${project}/repository/commits/${candidate.sha}`, ApiCommit).catch((error: unknown) => {
			if (isGone(error)) return undefined
			throw error
		})
		if (commit?.parent_ids.includes(sha) === true) return candidate
	}
	return undefined
}

/** The host halves of the pipeline and package tools. */
export function pipelineHostTools(api: ApiClient): HostTool[] {
	return [
		hostTool(pipelineOnCommit, async ({ repository, sha, ref, mergeRequest }, context) => {
			if (noCommit.test(sha)) return { status: 'pending' as const, failures: [] }
			const client = await api(context)
			const project = projectSegment(repository)
			const latest = await latestPipeline(client, project, { sha, ref, mergeRequest })
			if (latest === undefined) return { status: 'none' as const, failures: [] }
			const status: PipelineStatus = doneStates.has(latest.status) ? 'completed' : 'pending'
			const pipeline = { id: latest.id, url: latest.web_url }
			if (status === 'pending' || !failedStates.has(latest.status)) return { status, failures: [], pipeline }
			const path = `${project}/pipelines/${String(latest.id)}`
			// Jobs, and the triggers of downstream pipelines, which GitLab lists apart.
			const [jobs, bridges] = await Promise.all([
				client.all(`${path}/jobs`, ApiJob, { 'scope[]': 'failed' }),
				client.all(`${path}/bridges`, ApiJob, { 'scope[]': 'failed' }),
			])
			const failures: JobFailure[] = [...jobs, ...bridges]
				.filter((job) => job.allow_failure !== true)
				.map((job) => ({
					name: job.name,
					stage: job.stage,
					summary: job.failure_reason ?? job.status,
					...(job.web_url === undefined ? {} : { url: job.web_url }),
				}))
			// Canceled with nothing failed, or failed in a way no job says: the pipeline itself is the finding.
			const findings = failures.length > 0 ? failures : [{ name: 'pipeline', stage: '', summary: latest.status, url: latest.web_url }]
			return { status, failures: findings, pipeline }
		}),

		hostTool(pipelinePackages, async ({ repository, pipeline, type }, context) => {
			const client = await api(context)
			const ofPipeline = async (status?: string) => {
				const query = { package_type: type, order_by: 'created_at', sort: 'desc', ...(status === undefined ? {} : { status }) }
				const packages = await client.all(`${projectSegment(repository)}/packages`, ApiPackage, query)
				return packages.filter((found) => found.pipeline?.id === pipeline || (found.pipelines ?? []).some((built) => built.id === pipeline))
			}
			// GitLab lists the packages it is done with by default, and those it is still processing only when
			// asked. The ones it couldn't process are asked for too, whichever way the default goes.
			const [listed, processing, broken] = await Promise.all([ofPipeline(), ofPipeline('processing'), ofPipeline('error')])
			if (broken.length > 0)
				throw new Error(
					`GitLab couldn't process ${broken.map((found) => `${found.name} ${found.version}`).join(', ')} of pipeline ${String(pipeline)}.`,
				)
			const packages = listed.filter((found) => found.status !== 'error').map((found) => ({ name: found.name, version: found.version }))
			return { packages, processing: processing.length }
		}),
	]
}
