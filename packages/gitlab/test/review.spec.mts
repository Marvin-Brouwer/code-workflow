import { signed } from '@mesh-flow/code-repository/host'
import { describe, expect, test } from 'vitest'
import { reply } from '../src/merge-request/reply.mts'
import { review } from '../src/merge-request/review.mts'
import { triage } from '../src/merge-request/triage.mts'
import { checkout } from '../src/repository/repository.mts'
import type { ReviewItem } from '../src/tools/merge-request-tools.mts'
import { branch, connectedGitlab, projectPath, promptlyMs } from './support/connected-gitlab.mts'
import type { FakeNote } from './support/fake-gitlab.mts'
import { scriptedWriter } from './support/scripted-writer.mts'
import { runOnGateway } from './support/test-run.mts'

const where = { repository: projectPath, number: 3 }

/** The marker key of the 👀 on a note, as the reply that says it's being read carries it. */
function eyesKeyOf(note: FakeNote): string {
	const eyes = note.awards.find((award) => award.name === 'eyes')
	if (eyes === undefined) throw new Error('The note has no 👀 on it.')
	return `reaction:${String(eyes.id)}`
}

describe('review', () => {
	test("hands reviewers' notes to the handler with 👀 and a reading reply in their thread, leaves system notes and the run's own out, and ends when merged", async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		const request = api.mergeRequest(projectPath, 3)
		const onLine = api.note(projectPath, 3, 'Rename this.', { position: { new_path: 'login.txt', new_line: 1 } })
		const system = api.note(projectPath, 3, 'added 1 commit')
		system.system = true
		const handed: ReviewItem[][] = []
		const comments = (items: readonly ReviewItem[]) => {
			handed.push([...items])
			request.state = 'merged'
			return Promise.resolve()
		}

		// Act
		const run = await runOnGateway(gateway, () => review(where, { comments }, { every: { seconds: 0 } }))
		const outcome = await run.result

		// Assert
		expect(outcome.state).toBe('merged')
		expect(handed).toMatchObject([[{ id: `note/${String(onLine.id)}`, kind: 'diff-note', author: 'reviewer', path: 'login.txt', line: 1 }]])
		expect(onLine.awards.map((award) => award.name)).toEqual(['eyes'])
		const thread = api.discussionOf(projectPath, 3, onLine.id)
		expect(thread?.notes.map((note) => note.body)).toEqual([
			'Rename this.',
			signed('👀 Reading...', run.runId, ['reply', `seen:note/${String(onLine.id)}`, eyesKeyOf(onLine)]),
		])
	})

	test('hands a failed pipeline of the head commit to its handler once, with the jobs that failed', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		const head = 'a'.repeat(40)
		const request = api.mergeRequest(projectPath, 3, { sha: head })
		api.pipeline(projectPath, {
			sha: head,
			ref: 'feature',
			status: 'failed',
			jobs: [
				{ name: 'test', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/1', failure_reason: 'script_failure' },
				{ name: 'lint', stage: 'test', status: 'failed', web_url: 'https://gitlab.example/jobs/2', allow_failure: true },
				{ name: 'build', stage: 'build', status: 'success', web_url: 'https://gitlab.example/jobs/3' },
			],
		})
		const failed: unknown[] = []
		let looks = 0
		api.hold = (method, requestPath) => {
			// Merged on the third look at the merge request, so a second look at the same commit reports nothing.
			if (method === 'GET' && requestPath.endsWith('/merge_requests/3') && ++looks === 3) request.state = 'merged'
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, () =>
			review(where, { pipelineFailed: (pipeline) => Promise.resolve(failed.push(pipeline)) }, { every: { seconds: 0 } }),
		)
		await run.result

		// Assert
		expect(failed).toMatchObject([
			{ sha: head, failures: [{ name: 'test', stage: 'test', summary: 'script_failure', url: 'https://gitlab.example/jobs/1' }] },
		])
	})

	test('settles promptly when the run stops while GitLab never answers', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3)
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (_method, requestPath) => {
			if (!requestPath.endsWith('/discussions')) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, () => review(where, { comments: () => Promise.resolve() }))
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})

describe('triage and reply', () => {
	test('answers a question in place of the reading reply, plans a change, and answers the change as a reply of its own', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		const request = api.mergeRequest(projectPath, 3)
		const question = api.note(projectPath, 3, 'Why SameSite?')
		const change = api.note(projectPath, 3, 'Add a test.')
		const questionId = `note/${String(question.id)}`
		const changeId = `note/${String(change.id)}`
		const { writer } = scriptedWriter([
			{
				items: [
					{ id: questionId, asks: 'question', reply: 'Safari drops the cookie otherwise.' },
					{ id: changeId, asks: 'change', reply: 'I will add a test of the cookie.' },
				],
			},
		])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout(projectPath, { branch })
			let planned: unknown
			await review(
				where,
				{
					comments: async (comments) => {
						const changes = await triage(writer, repository, { mergeRequest: where, comments })
						for (const { item } of changes) await reply(where)({ item: item.id, text: 'Added the test.' })
						planned = changes.map(({ item, plan }) => ({ id: item.id, plan }))
						request.state = 'merged'
					},
				},
				{ every: { seconds: 0 } },
			)
			return planned
		})
		const planned = await run.result

		// Assert
		expect(planned).toEqual([{ id: changeId, plan: 'I will add a test of the cookie.' }])
		expect(api.discussionOf(projectPath, 3, question.id)?.notes.map((note) => note.body)).toEqual([
			'Why SameSite?',
			signed('Safari drops the cookie otherwise.', run.runId, ['reply', `answered:${questionId}`]),
		])
		expect(question.awards).toEqual([])
		const changeThread = api.discussionOf(projectPath, 3, change.id)?.notes.map((note) => note.body)
		expect(changeThread?.[1]).toContain('I will add a test of the cookie.')
		expect(changeThread?.[2]).toBe(signed('Added the test.', run.runId, ['reply', `replied:${changeId}`]))
		expect(change.awards).toEqual([])
	})

	test('leaves out a change whose note was deleted since it was read', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 3)
		const change = api.note(projectPath, 3, 'Add a test.')
		const item: ReviewItem = {
			id: `note/${String(change.id)}`,
			kind: 'note',
			author: 'reviewer',
			body: 'Add a test.',
			url: 'https://gitlab.example/x',
			at: new Date().toISOString(),
		}
		api.deleteNote(projectPath, 3, change.id)
		const { writer } = scriptedWriter([{ items: [{ id: item.id, asks: 'change', reply: 'I will add a test.' }] }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout(projectPath, { branch })
			return triage(writer, repository, { mergeRequest: where, comments: [item] })
		})

		// Assert
		expect(await run.result).toEqual([])
	})
})
