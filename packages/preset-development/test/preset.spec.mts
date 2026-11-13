import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { agent, runCheck, toPrompt } from '@mesh-flow/core'
import { describe, expect, it } from 'vitest'
import { codeReview, deviations, Plan, type ReviewedCheckout } from '../src/_module/preset-development.mts'
import { runBody } from './support/run-body.mts'
import { callsTool, modelId, neverAnswers, scriptedModel, textOf } from './support/scripted-model.mts'

const reviewer = agent({ model: modelId })

const repository: ReviewedCheckout = { name: 'team/api', defaultBranch: 'main', [toPrompt]: () => '/workspace/api' }

/** Long enough for a scripted review. */
const checkTimeoutMs = 10_000

/** The workspace the review's plan is in; the scripted reviewer never reads it. */
const workspaceDirectory = '/workspace'

function planIn(workspace: string): Plan {
	return Plan.parse({
		path: path.join(workspace, 'plan.md'),
		repositories: [{ name: 'team/api', changes: 'Publish refunds' }],
		dependencies: [],
	})
}

describe('deviations', () => {
	it('records each deviation in Markdown, under one heading', async () => {
		// Arrange
		const deviation = { repository: 'team/api', reason: 'A review comment on the refund handler', change: 'Refunds are queued' }

		// Act
		const run = await runBody(async () => {
			await deviations.record(deviation)
			return deviations.record({ ...deviation, change: 'Refunds are retried' })
		})

		// Assert
		const { recordedIn } = await run.result
		expect(recordedIn).toBe(path.join(run.workspace, 'plan-deviations.md'))
		expect(await readFile(recordedIn, 'utf8')).toBe(
			'# Deviations from the plan\n\n' +
				'## team/api\n\n- Found: A review comment on the refund handler\n- Deviation: Refunds are queued\n\n' +
				'## team/api\n\n- Found: A review comment on the refund handler\n- Deviation: Refunds are retried\n\n',
		)
	})
})

describe('codeReview', () => {
	it("reports the reviewer's findings, each with where it is", async () => {
		// Arrange
		const model = scriptedModel([
			callsTool('succeed', { findings: [{ where: 'src/Refunds.cs:12', message: 'The refund is never saved.' }] }),
		])

		// Act
		const run = await runBody(
			() => runCheck(codeReview(reviewer, repository, planIn(workspaceDirectory)), { abortSignal: AbortSignal.timeout(checkTimeoutMs) }),
			model.models,
		)

		// Assert
		expect(await run.result).toEqual([{ source: 'code review: src/Refunds.cs:12', message: 'The refund is never saved.' }])
		const prompt = textOf(model.requests[0])
		expect(prompt).toContain('git diff origin/main')
		expect(prompt).toContain('/workspace/api')
		expect(prompt).toContain('plan-deviations.md')
	})

	it('settles when the run stops while the reviewer never answers', async () => {
		// Arrange
		const model = scriptedModel([neverAnswers])
		const run = await runBody(
			() => runCheck(codeReview(reviewer, repository, planIn(workspaceDirectory)), { abortSignal: AbortSignal.timeout(checkTimeoutMs) }),
			model.models,
		)
		await expect.poll(() => model.requests.length).toBe(1)

		// Act
		run.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(run.outcome).resolves.toMatchObject({ status: 'failed' })
	})
})
