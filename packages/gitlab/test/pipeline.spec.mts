import { runCheck } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { pipelinePasses } from '../src/merge-request/pipeline-passes.mts'
import { publishedPackages } from '../src/merge-request/published-packages.mts'
import { connectedGitlab, projectPath, promptlyMs, quickRetry } from './support/connected-gitlab.mts'
import { runOnGateway } from './support/test-run.mts'

const where = { repository: projectPath, number: 3 }
const head = 'a'.repeat(40)
const merge = 'b'.repeat(40)
const quickly = { every: { seconds: 0 }, appearWithin: { seconds: 0 } }

describe('pipelinePasses', () => {
	test('reports each failed job of the head commit as a finding, once the pipeline completed', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		const pipeline = api.pipeline(projectPath, { sha: head, ref: 'feature', status: 'running' })
		let looks = 0
		api.hold = (_method, requestPath) => {
			if (requestPath.endsWith('/pipelines') && ++looks === 2) {
				pipeline.status = 'failed'
				pipeline.jobs = [
					{ name: 'test', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/1', failure_reason: 'script_failure' },
				]
			}
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))
		const findings = await run.result

		// Assert
		expect(findings).toEqual([{ source: 'pipeline: test/test', message: 'script_failure (https://gitlab.example/jobs/1)' }])
	})

	test('reports the failures of a merged results pipeline, which runs on a merge of the head into the target', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		api.pipeline(projectPath, {
			sha: merge,
			ref: 'refs/merge-requests/3/merge',
			status: 'failed',
			mergeRequest: 3,
			parents: ['c'.repeat(40), head],
			jobs: [{ name: 'lint', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/2' }],
		})

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([{ source: 'pipeline: test/lint', message: 'failed (https://gitlab.example/jobs/2)' }])
	})

	test("reports the merge request's own pipeline, which gates the merge, over a branch pipeline on the head", async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		api.pipeline(projectPath, { sha: head, ref: 'feature', status: 'success' })
		api.pipeline(projectPath, {
			sha: merge,
			ref: 'refs/merge-requests/3/merge',
			status: 'failed',
			mergeRequest: 3,
			parents: ['c'.repeat(40), head],
			jobs: [{ name: 'lint', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/2' }],
		})

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([{ source: 'pipeline: test/lint', message: 'failed (https://gitlab.example/jobs/2)' }])
	})

	test('passes over a merged results pipeline whose merge commit GitLab cleaned up', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		const failed = api.pipeline(projectPath, {
			sha: merge,
			ref: 'refs/merge-requests/3/merge',
			status: 'failed',
			mergeRequest: 3,
			parents: [head],
		})
		api.pipeline(projectPath, {
			sha: 'd'.repeat(40),
			ref: 'refs/merge-requests/3/merge',
			status: 'success',
			mergeRequest: 3,
			commitGone: true,
		})

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([{ source: 'pipeline: /pipeline', message: `failed (${failed.web_url})` }])
	})

	test('reports a downstream pipeline that failed, and leaves out jobs that may fail', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		api.pipeline(projectPath, {
			sha: head,
			ref: 'feature',
			status: 'failed',
			jobs: [{ name: 'flaky', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/3', allow_failure: true }],
			bridges: [
				{
					name: 'deploy',
					stage: 'deploy',
					status: 'failed',
					web_url: 'https://gitlab.example/jobs/4',
					failure_reason: 'downstream_pipeline_failure',
				},
			],
		})

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([
			{ source: 'pipeline: deploy/deploy', message: 'downstream_pipeline_failure (https://gitlab.example/jobs/4)' },
		])
	})

	test('passes a project without CI once no pipeline appeared in time', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([])
	})

	test('looks again when GitLab is down for a moment', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab(quickRetry)
		api.mergeRequest(projectPath, 3, { sha: head })
		api.pipeline(projectPath, { sha: head, ref: 'feature', status: 'success' })
		api.unavailableRequests = 4

		// Act
		const run = await runOnGateway(gateway, (context) => runCheck(pipelinePasses(where, quickly), context))

		// Assert
		expect(await run.result).toEqual([])
	})
})

describe('publishedPackages', () => {
	test('lists the packages the pipeline of the merge published, once it passed', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { state: 'merged', sha: head, merge_commit_sha: merge })
		const onMerge = api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'success' })
		const earlier = api.pipeline(projectPath, { sha: 'c'.repeat(40), ref: 'main', status: 'success' })
		api
			.project(projectPath)
			.packages.push(
				{ name: 'Team.Api.Client', version: '1.4.0', package_type: 'nuget', pipeline_id: onMerge.id },
				{ name: 'Team.Api.Client', version: '1.3.0', package_type: 'nuget', pipeline_id: earlier.id },
				{ name: '@team/api-client', version: '1.4.0', package_type: 'npm', pipeline_id: onMerge.id },
			)

		// Act
		const run = await runOnGateway(gateway, () => publishedPackages(where, 'nuget', quickly))

		// Assert
		expect(await run.result).toEqual([{ name: 'Team.Api.Client', version: '1.4.0' }])
	})

	test('waits for GitLab to process the packages of the pipeline before listing them', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { state: 'merged', sha: head, merge_commit_sha: merge })
		const onMerge = api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'success' })
		const uploaded = { name: 'Team.Api.Client', version: '1.4.0', package_type: 'nuget', pipeline_id: onMerge.id, status: 'processing' }
		api.project(projectPath).packages.push(uploaded)
		let looks = 0
		api.hold = (_method, requestPath) => {
			if (requestPath.endsWith('/packages') && ++looks === 3) uploaded.status = 'default'
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, () =>
			publishedPackages(where, 'nuget', { every: { seconds: 0 }, appearWithin: { seconds: 1 } }),
		)

		// Assert
		expect(await run.result).toEqual([{ name: 'Team.Api.Client', version: '1.4.0' }])
	})

	test('fails for a package GitLab could not process', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { state: 'merged', sha: head, merge_commit_sha: merge })
		const onMerge = api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'success' })
		api
			.project(projectPath)
			.packages.push({ name: 'Team.Api.Client', version: '1.4.0', package_type: 'nuget', pipeline_id: onMerge.id, status: 'error' })

		// Act
		const run = await runOnGateway(gateway, () => publishedPackages(where, 'nuget', quickly))

		// Assert
		await expect(run.result).rejects.toThrow("couldn't process Team.Api.Client 1.4.0")
	})

	test('fails for a merge request that is not merged, and for a merge whose pipeline failed', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { sha: head })
		api.mergeRequest(projectPath, 4, { state: 'merged', sha: head, merge_commit_sha: merge })
		api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'failed' })

		// Act
		const open = await runOnGateway(gateway, () => publishedPackages(where, 'nuget', quickly))
		const failed = await runOnGateway(gateway, () => publishedPackages({ repository: projectPath, number: 4 }, 'nuget', quickly))

		// Assert
		await expect(open.result).rejects.toThrow("isn't merged")
		await expect(failed.result).rejects.toThrow('failed')
	})

	test('fails for a merge whose pipeline waits for a person to start a job', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { state: 'merged', sha: head, merge_commit_sha: merge })
		api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'manual' })

		// Act
		const run = await runOnGateway(gateway, () => publishedPackages(where, 'nuget', quickly))

		// Assert
		await expect(run.result).rejects.toThrow('waits for a person to start a job')
	})

	test('settles promptly when the run stops while the pipeline never ends', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3, { state: 'merged', sha: head, merge_commit_sha: merge })
		api.pipeline(projectPath, { sha: merge, ref: 'main', status: 'running' })
		const { promise: looked, resolve } = Promise.withResolvers<undefined>()
		api.hold = (_method, requestPath) => {
			if (requestPath.endsWith('/pipelines')) resolve(undefined)
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, () => publishedPackages(where, 'nuget', { every: { seconds: 0 } }))
		await looked
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})
