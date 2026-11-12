import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { pipelineOnCommit, pipelinePackages, type JobFailure, type PipelineStatus } from '../tools/merge-request-tools.mts'
import { projectSegment, type ApiClient } from './api.mts'

const ApiPipeline = z.object({ id: z.int(), status: z.string(), web_url: z.url() })

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
	pipeline: z.object({ id: z.int() }).nullable().optional(),
	pipelines: z
		.array(z.object({ id: z.int() }))
		.nullable()
		.optional(),
})

/** Pipeline states after which nothing more runs on its own. A pipeline waiting on a manual job counts: nothing runs until someone starts it. */
const doneStates = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])

/** Pipeline states whose jobs are worth listing as failures. */
const failedStates = new Set(['failed', 'canceled'])

/** The host halves of the pipeline and package tools. */
export function pipelineHostTools(api: ApiClient): HostTool[] {
	return [
		hostTool(pipelineOnCommit, async ({ repository, sha, ref }, context) => {
			const client = await api(context)
			const project = projectSegment(repository)
			const { items } = await client.firstPage(`${project}/pipelines`, ApiPipeline, 1, { sha, ref, order_by: 'id', sort: 'desc' })
			const latest = items[0]
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
			const packages = await client.all(`${projectSegment(repository)}/packages`, ApiPackage, {
				package_type: type,
				order_by: 'created_at',
				sort: 'desc',
			})
			return packages
				.filter((found) => found.pipeline?.id === pipeline || (found.pipelines ?? []).some((built) => built.id === pipeline))
				.map((found) => ({ name: found.name, version: found.version }))
		}),
	]
}
