import {
	defaultAppearWithin,
	defaultLookEvery,
	defaultToleratedOutage,
	lookBudget,
	patientLook,
	type LookBudget,
} from '@mesh-flow/code-repository'
import { poll, wait, type ToolContext } from '@mesh-flow/core'
import { duration, type Duration } from '@mesh-flow/duration'
import { stubs } from '../stubs.mts'
import type { MergeRequestReference } from '../tools/merge-request-tools.mts'
import type { PackageType, PublishedPackage } from '../tools/pipeline-tools.mts'

/** How long GitLab may take to process uploaded packages, when no duration is given. */
const defaultProcessWithin = duration.of('10m')

/** Options of `publishedPackages`. */
export interface PublishedPackagesOptions {
	/** How long to wait between looks while the pipeline runs. Default: 10 seconds. */
	readonly every?: Duration
	/** How long to wait for the pipeline of the merge to appear. Default: 10 minutes. */
	readonly appearWithin?: Duration
	/** How long GitLab may take to process the packages the pipeline uploaded. Default: 10 minutes. */
	readonly processWithin?: Duration
	/**
	 * How long looks at GitLab may keep failing before `publishedPackages` fails with the last error.
	 * Default: 10 minutes.
	 */
	readonly toleratedOutage?: Duration
}

/** How `processedPackages` waits for GitLab to process a pipeline's packages. */
interface ProcessedPackagesOptions {
	/** What is waited for: the waiting bar's title. */
	readonly description: string
	/** How long to wait between looks. */
	readonly every: Duration
	/** Whether the packages may still be processing for another look. */
	readonly mayProcess: LookBudget
	/** The pipeline, for the error when processing takes too long. */
	readonly url: string
}

/**
 * The packages a pipeline published, once GitLab processed them all: it reads a NuGet package's
 * name and version after the upload, in the background. Fails when that takes longer than
 * `processing` has looks for.
 */
async function processedPackages(
	list: () => Promise<{ readonly packages: readonly PublishedPackage[]; readonly processing: number }>,
	{ description, every, mayProcess, url }: ProcessedPackagesOptions,
): Promise<readonly PublishedPackage[]> {
	for (;;) {
		const { packages, processing } = await list()
		if (processing === 0) return packages
		if (!mayProcess()) throw new Error(`GitLab is still processing ${String(processing)} package(s) of ${url}.`)
		await poll(description, () => wait(every))
	}
}

/**
 * The packages of `type` that the merge of a merge request published: it waits for the pipeline of
 * the commit the merge left on the target branch to complete, then lists the packages in the
 * project's package registry that pipeline built. A merge request that isn't merged, a pipeline
 * that failed or waits for a person to start a job, or no pipeline within `appearWithin`, fails
 * the call: the packages a dependent project would take don't exist, or may not yet. GitLab reads a
 * NuGet package's name and version after the upload, in the background, so it also waits, for up
 * to `processWithin`, until every package of that pipeline is processed. A look that fails is tried
 * again on the next one, for up to `toleratedOutage`.
 *
 * @param on - The merged merge request: anything with its `repository` and `number`.
 * @param type - The kind of package: `nuget`, `npm`, `maven`, `pypi` or `generic`.
 * @param options - How often to look, and how long to wait for the pipeline, the processing and
 * GitLab to answer again.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own. It stops the calls to
 * GitLab; the waits between looks stop with the run.
 * @returns Each package's name and version; none when the pipeline published no package of `type`.
 * @throws When the merge request isn't merged; when the pipeline of the merge failed, waits for a
 * person, or didn't appear within `appearWithin`; when GitLab couldn't process a package of the
 * pipeline, or still processes one after `processWithin`; and when looks at GitLab kept failing for
 * longer than `toleratedOutage`.
 *
 * @example Hand a library's new version to the projects that use it
 * ```ts
 * const { state } = await gitlab.review(libraryMergeRequest, handlers)
 * if (state === 'closed') throw new Error(`${libraryMergeRequest.url} was closed without a merge.`)
 * const packages = await gitlab.publishedPackages(libraryMergeRequest, 'nuget')
 * if (packages.length === 0) return
 * await dotnet.updatePackages(consumer, packages)
 * await gitlab.push(consumer)({ message: `Update to ${packages.map((published) => `${published.name} ${published.version}`).join(', ')}` })
 * ```
 */
export async function publishedPackages(
	on: MergeRequestReference,
	type: PackageType,
	options: PublishedPackagesOptions = {},
	context?: ToolContext,
): Promise<readonly PublishedPackage[]> {
	const every = options.every ?? defaultLookEvery
	const pipelineMayAppear = lookBudget(options.appearWithin ?? defaultAppearWithin, every)
	const mayProcess = lookBudget(options.processWithin ?? defaultProcessWithin, every)
	const description = `packages published by the merge of ${on.repository}!${String(on.number)}`
	const retrying = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	const look = async <Result,>(attempt: () => Promise<Result>) => poll(description, () => retrying(attempt))
	const merged = await look(() => stubs.getMergeRequest({ repository: on.repository, number: on.number }, context))
	if (!merged.merged || merged.mergedSha === undefined) throw new Error(`${merged.url} isn't merged, so it published nothing.`)
	const { mergedSha } = merged
	for (;;) {
		const pipeline = await look(() => stubs.pipelineOnCommit({ repository: on.repository, sha: mergedSha, ref: merged.base }, context))
		if (pipeline.status === 'completed' && pipeline.pipeline !== undefined) {
			if (pipeline.failures.length > 0)
				throw new Error(`The pipeline of the merge of ${merged.url} failed (${pipeline.pipeline.url}), so its packages aren't published.`)
			if (pipeline.pipeline.waitsOnManualJob)
				throw new Error(
					`The pipeline of the merge of ${merged.url} waits for a person to start a job (${pipeline.pipeline.url}), so its packages may not be published yet.`,
				)
			const { id, url } = pipeline.pipeline
			return processedPackages(() => look(() => stubs.pipelinePackages({ repository: on.repository, pipeline: id, type }, context)), {
				description,
				every,
				mayProcess,
				url,
			})
		}
		if (pipeline.status === 'none' && !pipelineMayAppear())
			throw new Error(`No pipeline ran on the merge of ${merged.url} (${mergedSha}), so it published nothing.`)
		await poll(description, () => wait(every))
	}
}
