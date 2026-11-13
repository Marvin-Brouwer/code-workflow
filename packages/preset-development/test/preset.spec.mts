import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agent, runCheck } from '@mesh-flow/core'
import { gitCommand } from '@mesh-flow/git'
import { describe, expect, test } from 'vitest'
import { codeReview, deviations, Plan } from '../src/_module/preset-development.mts'
import { gitCheckout } from './support/git-checkout.mts'
import { runBody } from './support/run-body.mts'
import { callsTool, modelId, neverAnswers, scriptedModel, textOf } from './support/scripted-model.mts'

const reviewer = agent({ model: modelId })

/** Long enough for a scripted review. */
const checkTimeoutMs = 10_000

/** The workspace the review's plan is in; the scripted reviewer never reads it. */
const workspaceDirectory = '/workspace'

function planIn(workspace: string): Plan {
	return Plan.parse({
		path: path.join(workspace, 'plan.md'),
		repositories: [{ repository: 'team/api', changes: 'Publish refunds' }],
		dependencies: [],
	})
}

describe('deviations', () => {
	test('records each deviation in Markdown, under one heading', async () => {
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

	test('records deviations made side by side under one heading', async () => {
		// Arrange
		const deviation = { repository: 'team/api', reason: 'A review comment on the refund handler', change: 'Refunds are queued' }
		const other = { repository: 'team/web', reason: 'A pipeline', change: 'Refunds show as pending' }

		// Act
		const run = await runBody(async () => {
			const [recorded] = await Promise.all([deviations.record(deviation), deviations.record(other), deviations.record(deviation)])
			return recorded
		})

		// Assert
		const { recordedIn } = await run.result
		expect(await readFile(recordedIn, 'utf8')).toBe(
			'# Deviations from the plan\n\n' +
				'## team/api\n\n- Found: A review comment on the refund handler\n- Deviation: Refunds are queued\n\n' +
				'## team/web\n\n- Found: A pipeline\n- Deviation: Refunds show as pending\n\n',
		)
	})

	test('records a deviation once when it is recorded again, as by a loop that runs again', async () => {
		// Arrange
		const deviation = { repository: 'team/api', reason: 'A review comment on the refund handler', change: 'Refunds are queued' }

		// Act
		const run = await runBody(async () => {
			await deviations.record(deviation)
			return deviations.record(deviation)
		})

		// Assert
		const { recordedIn } = await run.result
		expect(await readFile(recordedIn, 'utf8')).toBe(
			'# Deviations from the plan\n\n' +
				'## team/api\n\n- Found: A review comment on the refund handler\n- Deviation: Refunds are queued\n\n',
		)
	})

	test('records nothing once the run stopped', async () => {
		// Arrange
		const deviation = { repository: 'team/api', reason: 'A pipeline', change: 'Refunds are queued' }
		const stopped = AbortSignal.abort(new Error('The run stopped.'))

		// Act
		const recording = deviations.record(deviation, { abortSignal: stopped })

		// Assert
		await expect(recording).rejects.toThrow('The run stopped.')
	})
})

describe('codeReview', () => {
	test("reports the reviewer's findings, each with where it is", async () => {
		// Arrange
		const repository = await gitCheckout()
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
		const { stdout: base } = await gitCommand(['rev-parse', 'origin/main'], {
			cwd: repository.directory,
			abortSignal: AbortSignal.timeout(checkTimeoutMs),
		})
		expect(prompt).toContain(`git diff ${base.trim()}`)
		// The requests are JSON, where a Windows path's backslashes are escaped.
		expect(prompt).toContain(JSON.stringify(repository.directory).slice(1, -1))
		expect(prompt).toContain('plan-deviations.md')
	})

	test('reviews each state of the checkout in a loop of its own, untracked files included', async () => {
		// Arrange
		const repository = await gitCheckout()
		const noFindings = callsTool('succeed', { findings: [] })
		const model = scriptedModel([noFindings, noFindings, noFindings])
		const review = codeReview(reviewer, repository, planIn(workspaceDirectory))
		const reviewNow = async () =>
			(await runBody(() => runCheck(review, { abortSignal: AbortSignal.timeout(checkTimeoutMs) }), model.models)).result

		// Act
		await reviewNow()
		await reviewNow()
		await writeFile(path.join(repository.directory, 'Refunds.cs'), 'class Refunds {}\n')
		await reviewNow()

		// Assert
		const [first, unchanged, withNewFile] = model.requests.map((request) => /\(state (\w+)\)/.exec(textOf(request))?.[1])
		expect(first).toBeDefined()
		expect(unchanged).toBe(first)
		expect(withNewFile).not.toBe(first)
	})

	test('reviews a checkout with an untracked nested repository and a dangling link', async () => {
		// Arrange
		const repository = await gitCheckout()
		await mkdir(path.join(repository.directory, 'sample', '.git'), { recursive: true })
		await writeFile(path.join(repository.directory, 'sample', '.git', 'HEAD'), 'ref: refs/heads/main\n')
		await symlink('missing.cs', path.join(repository.directory, 'dangling.cs'))
		const model = scriptedModel([callsTool('succeed', { findings: [] })])

		// Act
		const run = await runBody(
			() => runCheck(codeReview(reviewer, repository, planIn(workspaceDirectory)), { abortSignal: AbortSignal.timeout(checkTimeoutMs) }),
			model.models,
		)

		// Assert
		expect(await run.result).toEqual([])
	})

	test('settles when the run stops while the reviewer never answers', async () => {
		// Arrange
		const repository = await gitCheckout()
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
