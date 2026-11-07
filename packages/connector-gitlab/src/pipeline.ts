import { check } from '@mesh-flow/core'
import { api, type MergeRequest } from './api'

/** Waits for the pipeline of the latest commit; its failed jobs are the findings. */
export function pipelinePasses(mergeRequest: MergeRequest) {
	return check('pipeline', async () => {
		const pipeline = await api.waitForPipeline(mergeRequest)
		return pipeline.failedJobs.map((job) => ({ source: `pipeline: ${job.name}`, message: job.log }))
	})
}
