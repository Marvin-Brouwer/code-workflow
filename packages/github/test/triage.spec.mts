import { describe, expect, test } from 'vitest'
import { signed } from '../src/host/signature.mts'
import { triage, triageResult } from '../src/pull-request/triage.mts'
import { checkout } from '../src/repository/repository.mts'
import { stubs } from '../src/stubs.mts'
import type { ReviewItem } from '../src/tools/pull-request-tools.mts'
import { branch, connectedGithub, promptlyMs, repositoryName } from './support/connected-github.mts'
import { reactionsOf } from './support/fake-github.mts'
import { scriptedWriter } from './support/scripted-writer.mts'
import { runOnGateway } from './support/test-run.mts'

/** The pull request the review is on. */
const pullRequestNumber = 4

/** Where the review is. */
const where = { repository: repositoryName, number: pullRequestNumber }

/** A question and a request for a change, on the conversation. */
const question = { id: 1, body: 'Why SameSite=None?' }
const change = { id: 2, body: 'Add a test for Safari.' }

/** A fake GitHub whose pull request has the question and the change on its conversation, and the items as `review` hands them. */
async function reviewed() {
	const connected = await connectedGithub()
	const pull = connected.api.pullRequest(repositoryName, pullRequestNumber)
	const at = new Date().toISOString()
	const comments: ReviewItem[] = []
	for (const { id, body } of [question, change]) {
		const url = `${pull.html_url}#c${String(id)}`
		pull.comments.push({ id, body, user: { login: 'reviewer' }, html_url: url, created_at: at })
		comments.push({ id: `comment/${String(id)}`, kind: 'comment', author: 'reviewer', body, url, at })
	}
	return { ...connected, pull, comments }
}

describe('triage', () => {
	test('answers a question in place of the reading reply, and plans a change there, which it hands back', async () => {
		// Arrange
		const { pull, comments, gateway } = await reviewed()
		const { writer, prompts } = scriptedWriter([
			{
				items: [
					{ id: 'comment/2', asks: 'change', reply: 'I will add a Safari test.' },
					{ id: 'comment/1', asks: 'question', reply: 'Safari drops it otherwise.' },
				],
			},
		])

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items: comments.map(({ id, url }) => ({ id, url })) })
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments })
		})
		const changes = await run.result

		// Assert
		expect(prompts[0]).toContain('change nothing')
		expect(changes).toEqual([{ item: comments[1], plan: 'I will add a Safari test.' }])
		const [, , answer, plan] = pull.comments
		expect(answer?.body).toBe(signed('Safari drops it otherwise.', run.runId, ['reply', 'answered:comment/1']))
		expect(plan?.body).toContain('I will add a Safari test.')
		expect(plan?.body).toContain('<!-- mesh-flow:planned:comment/2 -->')
		// The change is still being worked on, the question is answered.
		expect(pull.comments.slice(0, 2).map(reactionsOf)).toEqual([[], ['eyes']])
	})

	test('answers a change the agent declines, and hands it back no more than a question', async () => {
		// Arrange
		const { pull, comments, gateway } = await reviewed()
		const { writer } = scriptedWriter([
			{
				items: [
					{ id: 'comment/1', asks: 'question', reply: 'Safari drops it otherwise.' },
					{ id: 'comment/2', asks: 'declined', reply: 'The e2e suite covers Safari already.' },
				],
			},
		])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments })
		})
		const changes = await run.result

		// Assert
		expect(changes).toEqual([])
		expect(pull.comments.at(-1)?.body).toBe(signed('The e2e suite covers Safari already.', run.runId, ['reply', 'replied:comment/2']))
	})

	test('leaves out a line comment deleted since it was read', async () => {
		// Arrange
		const { pull, gateway } = await reviewed()
		const deleted: ReviewItem = {
			id: 'review-comment/9',
			kind: 'review-comment',
			author: 'reviewer',
			body: 'Rename this.',
			url: `${pull.html_url}#r9`,
			at: new Date().toISOString(),
		}
		const { writer } = scriptedWriter([{ items: [{ id: deleted.id, asks: 'change', reply: 'I will rename it.' }] }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments: [deleted] })
		})

		// Assert
		await expect(run.result).resolves.toEqual([])
		expect(pull.reviewComments).toEqual([])
	})

	test('fails when GitHub will not take a reply on the conversation, rather than say the item is gone', async () => {
		// Arrange
		const { api, comments, gateway } = await reviewed()
		const { writer } = scriptedWriter([
			{
				items: [
					{ id: 'comment/1', asks: 'question', reply: 'Because.' },
					{ id: 'comment/2', asks: 'change', reply: 'I will add one.' },
				],
			},
		])
		api.failWith = (method) => (method === 'POST' ? 404 : undefined)

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments })
		})

		// Assert
		await expect(run.result).rejects.toThrow()
	})

	test('runs no loop for no items', async () => {
		// Arrange
		const { gateway } = await reviewed()
		const { writer, prompts } = scriptedWriter([])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments: [] })
		})

		// Assert
		await expect(run.result).resolves.toEqual([])
		expect(prompts).toEqual([])
	})

	test('stops promptly when the run stops while GitHub never takes the reply', async () => {
		// Arrange
		const { api, comments, gateway } = await reviewed()
		const { writer } = scriptedWriter([{ items: [{ id: 'comment/1', asks: 'question', reply: 'Because.' }] }])
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (method) => {
			if (method !== 'POST') return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			return triage(writer, repository, { pullRequest: where, comments: comments.slice(0, 1) })
		})
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})

describe('triageResult', () => {
	test('takes every item once', async () => {
		// Arrange
		const { comments } = await reviewed()

		// Act
		const parsed = triageResult(comments).safeParse({
			items: [
				{ id: 'comment/1', asks: 'question', reply: 'Because.' },
				{ id: 'comment/2', asks: 'change', reply: 'Will do.' },
			],
		})

		// Assert
		expect(parsed.success).toBe(true)
	})

	test('tells the agent which items are missing, unknown or sorted twice', async () => {
		// Arrange
		const { comments } = await reviewed()

		// Act
		const parsed = triageResult(comments).safeParse({
			items: [
				{ id: 'comment/1', asks: 'question', reply: 'Because.' },
				{ id: 'comment/1', asks: 'change', reply: 'Will do.' },
				{ id: 'comment/9', asks: 'change', reply: 'Will do.' },
			],
		})

		// Assert
		expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
			'Sort these items too: comment/2.',
			"These items weren't listed: comment/9.",
			'Sort each item once: comment/1.',
		])
	})
})
