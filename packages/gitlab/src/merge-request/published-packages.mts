import { wait, type ToolContext, type WaitSpec } from '@mesh-flow/core'
import { defaultAppearWithin, defaultLookEvery, defaultToleratedOutage, looksWithin, patientLook } from '@mesh-flow/code-repository'
import { stubs } from '../stubs.mts'
import type { MergeRequestRef, PackageType, PublishedPackage } from '../tools/merge-request-tools.mts'

/** Options of `publishedPackages`. */
export interface PublishedPackagesOptions {
	/** How long to wait between looks while the pipeline runs. Default: 10 seconds. */
	readonly every?: WaitSpec
	/** How long to wait for the pipeline of the merge to appear. Default: 10 minutes. */
	readonly appearWithin?: WaitSpec
	/** How long looks at GitLab may keep failing before it fails with the last error. Default: 10 minutes. */
	readonly toleratedOutage?: WaitSpec
}

/**
 * The packages a pipeline published, once GitLab processed them all: it reads a NuGet package's
 * name and version after the upload, in the background. Fails when that takes more than `looks`.
 */
async function processedPackages(
	list: () => Promise<{ readonly packages: readonly PublishedPackage[]; readonly processing: number }>,
	{ every, looks, url }: { readonly every: WaitSpec; readonly looks: number; readonly url: string },
): Promise<readonly PublishedPackage[]> {
	for (let look = 0; ; look++) {
		const { packages, processing } = await list()
		if (processing === 0) return packages
		if (look >= looks) throw new Error(`GitLab is still processing ${String(processing)} package(s) of ${url}.`)
		await wait(every)
	}
}

/**
 * The packages of `type` that the merge of a merge request published: it waits for the pipeline of
 * the commit the merge left on the target branch to complete, then lists the packages in the
 * project's package registry that pipeline built. A merge request that isn't merged, a pipeline
 * that failed, or no pipeline within `appearWithin`, fails the call: the packages a dependent
 * project would take don't exist.
 *
 * ```ts
 * await gitlab.review(mergeRequest, handlers)
 * const packages = await gitlab.publishedPackages(mergeRequest, 'nuget')
 * ```
 */
export async function publishedPackages(
	on: MergeRequestRef,
	type: PackageType,
	options: PublishedPackagesOptions = {},
	context?: ToolContext,
): Promise<readonly PublishedPackage[]> {
	const every = options.every ?? defaultLookEvery
	const looksForPipelineToAppear = looksWithin(options.appearWithin ?? defaultAppearWithin, every)
	const look = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	const merged = await look(() => stubs.getMergeRequest({ repository: on.repository, number: on.number }, context))
	if (!merged.merged || merged.mergedSha === undefined) throw new Error(`${merged.url} isn't merged, so it published nothing.`)
	const { mergedSha } = merged
	let looksWithoutPipeline = 0
	for (;;) {
		const pipeline = await look(() => stubs.pipelineOnCommit({ repository: on.repository, sha: mergedSha, ref: merged.base }, context))
		if (pipeline.status === 'completed' && pipeline.pipeline !== undefined) {
			if (pipeline.failures.length > 0)
				throw new Error(`The pipeline of the merge of ${merged.url} failed (${pipeline.pipeline.url}), so its packages aren't published.`)
			const { id, url } = pipeline.pipeline
			return processedPackages(() => look(() => stubs.pipelinePackages({ repository: on.repository, pipeline: id, type }, context)), {
				every,
				looks: looksForPipelineToAppear,
				url,
			})
		}
		if (pipeline.status === 'none' && ++looksWithoutPipeline > looksForPipelineToAppear)
			throw new Error(`No pipeline ran on the merge of ${merged.url} (${mergedSha}), so it published nothing.`)
		await wait(every)
	}
}
