import { BranchName, Sha } from '@mesh-flow/code-repository'
import { z } from 'zod'
import { ProjectPath } from '../project-path.mts'

/** A job of a pipeline that failed. */
export const JobFailure = z.object({ name: z.string(), stage: z.string(), summary: z.string(), url: z.url().optional() })
export type JobFailure = z.infer<typeof JobFailure>

/** How far the pipeline of a commit is: none yet, running, or done. */
export const PipelineStatus = z.enum(['none', 'pending', 'completed'])
export type PipelineStatus = z.infer<typeof PipelineStatus>

/**
 * Reads on the host the latest pipeline of a commit, on `ref` when one is named, and the jobs of it
 * that failed. With a merge request, a merged results pipeline counts too: it runs on a commit that
 * merges the head into the target, not on the head itself. A pipeline waiting on a manual job
 * counts as completed: nothing runs until someone starts it. A commit GitLab hasn't filled in yet,
 * all zeros, has its pipeline still to come.
 */
export const pipelineOnCommit = {
	name: 'gitlabPipeline',
	description: 'Reads the latest pipeline of a commit on GitLab and its failed jobs',
	input: z.object({ repository: ProjectPath, sha: Sha, ref: BranchName.optional(), mergeRequest: z.int().min(1).optional() }),
	output: z.object({
		status: PipelineStatus,
		failures: z.array(JobFailure),
		/** The pipeline, once there is one, and whether it waits for a person to start one of its jobs. */
		pipeline: z.object({ id: z.int(), url: z.url(), waitsOnManualJob: z.boolean() }).optional(),
	}),
}

/** The kinds of package GitLab's package registry keeps that `publishedPackages` lists. */
export const PackageType = z.enum(['nuget', 'npm', 'maven', 'pypi', 'generic'])
export type PackageType = z.infer<typeof PackageType>

/** A package in GitLab's package registry. */
export const PublishedPackage = z.object({ name: z.string(), version: z.string(), url: z.url().optional() })
export type PublishedPackage = z.infer<typeof PublishedPackage>

/** Lists on the host the packages of a type that pipeline `pipeline` published to the project's registry. */
export const pipelinePackages = {
	name: 'gitlabPipelinePackages',
	description: "Lists the packages a pipeline published to a GitLab project's package registry",
	input: z.object({ repository: ProjectPath, pipeline: z.int().positive(), type: PackageType }),
	output: z.object({
		packages: z.array(PublishedPackage),
		/** How many of the pipeline's packages GitLab is still processing, such as a NuGet package whose name and version it hasn't read yet. */
		processing: z.int().min(0),
	}),
}
