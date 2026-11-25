import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { signed, withHeader } from '@mesh-flow/code-repository/host'
import { runCheck, toPrompt, workspace } from '@mesh-flow/core'
import { duration } from '@mesh-flow/duration'
import { defaultFetchRetry, type FetchRetryOptions } from '@mesh-flow/gateway'
import type { RuntimeMessage } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { githubHostTools } from '../src/host/connector.mts'
import { deletedItemHeader, quoteHeader } from '../src/host/reply-header.mts'
import { close, collect, comment, label } from '../src/issue/issue.mts'
import { checksPass } from '../src/pull-request/checks-pass.mts'
import { openPullRequest } from '../src/pull-request/pull-request.mts'
import { reply } from '../src/pull-request/reply.mts'
import { review } from '../src/pull-request/review.mts'
import { push } from '../src/repository/push.mts'
import { checkout } from '../src/repository/repository.mts'
import { stubs } from '../src/stubs.mts'
import { fakeGithub, reactionsOf, shaOf, type FakeCheckRun, type FakeComment } from './support/fake-github.mts'
import { git, localRemote } from './support/local-remote.mts'
import { beingRead, replyingTo } from './support/review-items.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runOnGateway, testGateway, testToken } from './support/test-run.mts'

const repositoryName = 'team/app'

/** A fake GitHub, a local remote standing in for its git side, and a gateway with the connector's host tools on them. */
async function connected(retry: FetchRetryOptions = defaultFetchRetry) {
	const api = await fakeGithub()
	const remote = await localRemote()
	const gateway = await testGateway(
		githubHostTools({ directory: await temporaryDirectory(), apiUrl: api.url, remoteUrl: () => remote.url, retry }),
	)
	return { api, remote, gateway }
}

/** Host retries that are over in a moment. */
const quickRetry: FetchRetryOptions = {
	waits: [duration.of('1ms'), duration.of('1ms')],
	longestRetryAfter: duration({}),
	attemptTimeout: duration.of('1s'),
}

/** No host retries, so every request GitHub doesn't answer fails its call. */
const noRetry: FetchRetryOptions = { ...quickRetry, waits: [] }

/** How soon a run that stopped has to settle. */
const promptly = duration.of('1s')

/** Long enough for a second answer that didn't wait its turn to have listed the comments. */
const secondLook = duration.of('300ms')

/** The tools a run called, split by whether a `poll` event is above the call, with the polls' descriptions. */
function toolCallsByPoll(messages: readonly RuntimeMessage[]) {
	const events = messages.flatMap((message) => (message.type === 'event' ? [message.event] : []))
	const byId = new Map(events.map((event) => [event.id, event]))
	const pollAbove = (event: (typeof events)[number]): (typeof events)[number] | undefined => {
		const parent = event.parentId === undefined ? undefined : byId.get(event.parentId)
		if (parent === undefined) return undefined
		return parent.type === 'poll' ? parent : pollAbove(parent)
	}
	const calls = events.filter((event) => event.type === 'tool-call')
	return {
		descriptions: [...new Set(events.filter((event) => event.type === 'poll').map((event) => event.description))],
		inPolls: [...new Set(calls.filter((call) => pollAbove(call) !== undefined).map((call) => call.tool))],
		outsidePolls: [...new Set(calls.filter((call) => pollAbove(call) === undefined).map((call) => call.tool))],
	}
}

/** The marker key of the 👀 reaction on a comment, as the reply that says it's being read carries it. */
function eyesKeyOf(item: FakeComment | undefined): string {
	const eyes = item?.reactions?.find((reaction) => reaction.content === 'eyes')
	if (eyes === undefined) throw new Error('The comment has no 👀 on it.')
	return `reaction:${String(eyes.id)}`
}

describe('github', () => {
	test('collects an issue into the workspace, renders it as the dump, and comments, labels and closes it on the host', async () => {
		// Arrange
		const { api, gateway } = await connected()
		api.issue(repositoryName, 7, {
			title: 'Login fails on Safari',
			body: 'Steps: open the login page in Safari.',
			labels: [{ name: 'bug' }],
		})

		// Act
		const run = await runOnGateway(gateway, async () => {
			const issue = await collect({ repository: repositoryName, number: 7 })
			await comment(issue, 'On it.', { key: 'status' })
			await comment(issue, 'Still on it.', { key: 'status' })
			await comment(issue, 'Found it.')
			await label(issue, ['ai-fix'])
			await close(issue)
			return { issue, rendered: issue[toPrompt]() }
		})
		const { issue, rendered } = await run.result

		// Assert
		expect(rendered).toBe(path.join(run.workspace, 'issues/team--app-7.md'))
		expect(issue.title).toBe('Login fails on Safari')
		const dump = await readFile(path.join(run.workspace, issue.path), 'utf8')
		expect(dump).toContain('# #7: Login fails on Safari')
		expect(dump).toContain('- Labels: bug')
		expect(dump).toContain('Steps: open the login page in Safari.')
		const stored = api.issue(repositoryName, 7)
		expect(stored.comments.map((posted) => posted.body)).toEqual([
			// Spelled out once, so a change to the footer shows here.
			`Still on it.\n\n---\nGenerated by [\`@mesh-flow/*\`](https://github.com/Marvin-Brouwer/code-workflow)\n\`${run.runId}\`\n<!-- mesh-flow:key:status -->`,
			signed('Found it.', run.runId, ['comment']),
		])
		expect(stored.labels.map((known) => known.name)).toEqual(['bug', 'ai-fix'])
		expect(stored.state).toBe('closed')
		expect(api.tokens).toEqual(new Set([testToken]))
	})

	test('checks out on a new branch, pushes commits through the host, and opens one pull request for them', async () => {
		// Arrange
		const { api, remote, gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'fix.txt'), 'fixed\n')
			const pushed = await push(repository)({ message: 'Fix the login' })
			const nothing = await push(repository)({ message: 'Nothing changed' })
			const opened = await openPullRequest(repository, { title: 'Fix the login', description: 'Fixes #7' })
			const again = await openPullRequest(repository, { title: 'Fix the login', description: 'Fixes #7' })
			const same = await checkout({ repository: repositoryName, branch: 'fix/7' })
			return { repository, pushed, nothing, opened, again, same, rendered: repository[toPrompt]() }
		})
		const result = await run.result

		// Assert
		expect(result.rendered).toBe(path.join(run.workspace, 'repositories', 'team', 'app'))
		expect(result.repository.directory).toBe(path.join(run.workspace, 'repositories', 'team', 'app'))
		expect(result.pushed).toMatchObject({ pushed: true, head: await remote.head('fix/7') })
		expect(result.nothing).toMatchObject({ pushed: false })
		expect(await remote.files('fix/7')).toEqual(['README.md', 'fix.txt'])
		expect((await git(result.repository.directory, 'log', '--format=%an %s', 'fix/7')).split('\n')).toEqual([
			'mesh-flow Fix the login',
			'Test Start',
		])
		expect(result.opened).toMatchObject({ number: 1, head: { branch: 'fix/7' }, base: 'main' })
		expect(result.again.number).toBe(1)
		expect(api.repository(repositoryName).pulls.size).toBe(1)
		expect(result.same.directory).toBe(result.repository.directory)
	})

	test('pushes on top of a branch that exists on GitHub', async () => {
		// Arrange
		const { remote, gateway } = await connected()
		await remote.commit('fix/7', 'earlier.txt', 'earlier\n')

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'later.txt'), 'later\n')
			return push(repository)({ message: 'Later' })
		})
		await run.result

		// Assert
		expect(await remote.files('fix/7')).toEqual(['README.md', 'earlier.txt', 'later.txt'])
	})

	test('refuses to push a new branch that holds nothing the default branch does not, naming it', async () => {
		// Arrange
		const { remote, gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () =>
			push(await checkout({ repository: repositoryName, branch: 'fix/7' }))({ message: 'Nothing' }),
		)

		// Assert
		await expect(run.result).rejects.toThrow('fix/7 in team/app has no commits on top of main, so there is nothing to push.')
		await expect(remote.head('fix/7')).rejects.toThrow()
	})

	test("watches a pull request: hands new review items to the handler with eyes on them, leaves the run's own out, and ends when it is merged", async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 3, { head: { ref: 'fix/7', sha: shaOf('fix/7') } })
		const at = new Date().toISOString()
		pull.reviewComments.push({
			id: 1,
			body: 'Rename this.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#r1`,
			created_at: at,
			path: 'fix.txt',
			line: 1,
		})
		pull.reviewComments.push({
			id: 6,
			body: 'And this one.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#r6`,
			created_at: at,
			path: 'fix.txt',
			line: 1,
			in_reply_to_id: 1,
		})
		pull.comments.push({
			id: 2,
			body: 'Working on it.\n\n<!-- mesh-flow:key:status -->',
			user: { login: api.self },
			html_url: `${pull.html_url}#c2`,
			created_at: at,
		})
		// The token is often the reviewer's own: what they write is still a reviewer's.
		pull.comments.push({ id: 4, body: 'Also the README.', user: { login: api.self }, html_url: `${pull.html_url}#c4`, created_at: at })
		pull.reviews.push({
			id: 5,
			body: 'Close.',
			state: 'CHANGES_REQUESTED',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#v5`,
			submitted_at: at,
		})
		const comments = vi.fn<(items: readonly { id: string; body: string }[]) => Promise<void>>(async (items) => {
			await reply({ repository: repositoryName, number: 3 })({ item: items[0]?.id ?? '', text: 'Renamed.' })
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 3 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged', pullRequest: { number: 3, merged: true } })
		expect(comments).toHaveBeenCalledTimes(1)
		expect(comments.mock.calls[0]?.[0]).toMatchObject([
			{ id: 'review-comment/1', kind: 'review-comment', author: 'reviewer', body: 'Rename this.', path: 'fix.txt', line: 1 },
			{ id: 'review-comment/6', inReplyTo: 'review-comment/1' },
			{ id: 'review/5', kind: 'review', verdict: 'changes_requested' },
			{ id: 'comment/4', kind: 'comment', author: api.self, body: 'Also the README.' },
		])
		// The answered comment's 👀 came off again; the others are still being read.
		expect(pull.reviewComments.map(reactionsOf)).toEqual([[], ['eyes'], [], []])
		expect(pull.comments.map((posted) => [posted.body, reactionsOf(posted)])).toEqual([
			['Working on it.\n\n<!-- mesh-flow:key:status -->', []],
			['Also the README.', ['eyes']],
			[signed(replyingTo(pull.reviews[0], '👀 Reading...'), run.runId, ['reply', 'seen:review/5']), []],
			[signed(replyingTo(pull.comments[1], '👀 Reading...'), run.runId, ['reply', 'seen:comment/4', eyesKeyOf(pull.comments[1])]), []],
		])
		expect(pull.reviewComments.map((posted) => [posted.body, posted.in_reply_to_id])).toEqual([
			['Rename this.', undefined],
			['And this one.', 1],
			[signed('Renamed.', run.runId, ['reply', 'answered:review-comment/1']), 1],
			// A thread only takes replies to its first comment.
			[signed('👀 Reading...', run.runId, ['reply', 'seen:review-comment/6', eyesKeyOf(pull.reviewComments[1])]), 1],
		])
		expect(run.wakes).toBeGreaterThanOrEqual(1)
		// The looks are what the waiting bar folds; showing items as being read and the handler's work show on their own.
		expect(toolCallsByPoll(run.messages)).toEqual({
			descriptions: ['review of team/app#3'],
			inPolls: ['githubPullRequest', 'githubReviewActivity'],
			outsidePolls: ['githubShowBeingRead', 'reply', 'githubReply'],
		})
	})

	test('hands over a comment on a whole file, which has no line', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 9, { head: { ref: 'fix/7', sha: shaOf('fix/7') } })
		pull.reviewComments.push({
			id: 1,
			body: 'This file does not follow Arrange/Act/Assert.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#r1`,
			created_at: new Date().toISOString(),
			path: 'fix.txt',
			line: null,
		})
		const comments = vi.fn<(items: readonly { id: string }[]) => Promise<void>>(async () => {
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 9 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged' })
		expect(comments.mock.calls[0]?.[0]).toMatchObject([{ id: 'review-comment/1', path: 'fix.txt' }])
		expect(comments.mock.calls[0]?.[0][0]).not.toHaveProperty('line')
	})

	test('marks a review as being read with a reply on the conversation, which the first answer to the review replaces', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 8, { head: { ref: 'fix/7', sha: shaOf('fix/7') } })
		pull.reviews.push({
			id: 5,
			body: 'Please add a test.',
			state: 'CHANGES_REQUESTED',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#v5`,
			submitted_at: new Date().toISOString(),
		})
		const seen: string[] = []
		const comments = vi.fn<(items: readonly { id: string }[]) => Promise<void>>(async (items) => {
			seen.push(...pull.comments.map((posted) => posted.body))
			const answer = reply({ repository: repositoryName, number: 8 })
			await answer({ item: items[0]?.id ?? '', text: 'Added one.' })
			await answer({ item: items[0]?.id ?? '', text: 'And another.' })
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 8 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged' })
		expect(seen).toEqual([signed(replyingTo(pull.reviews[0], '👀 Reading...'), run.runId, ['reply', 'seen:review/5'])])
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			signed(replyingTo(pull.reviews[0], 'Added one.'), run.runId, ['reply', 'answered:review/5']),
			signed(replyingTo(pull.reviews[0], 'And another.'), run.runId, ['reply', 'replied:review/5']),
		])
	})

	test('shows an item as being read once, leaves an answered one alone, and answers once when the 👀 was taken off already', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 12)
		pull.comments.push({
			id: 1,
			body: 'Typo here.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 12 }
		const items = [beingRead('comment', pull.comments[0])]

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items })
			const again = await stubs.showBeingRead({ ...where, items })
			// The reviewer took the 👀 off, which is theirs too with their own token.
			const reviewed = pull.comments[0]
			if (reviewed !== undefined) reviewed.reactions = []
			await reply(where)({ item: 'comment/1', text: 'Fixed.' })
			const afterAnswer = await stubs.showBeingRead({ ...where, items })
			return { again, afterAnswer }
		})
		const { again, afterAnswer } = await run.result

		// Assert
		expect(again.shown).toEqual(['comment/1'])
		expect(afterAnswer.shown).toEqual([])
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Typo here.',
			signed(replyingTo(pull.comments[0], 'Fixed.'), run.runId, ['reply', 'answered:comment/1']),
		])
		expect(reactionsOf(pull.comments[0])).toEqual([])
	})

	test('answers a line comment that replies to another in the thread it is in, which only takes replies to its first comment', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 13)
		const at = new Date().toISOString()
		const line = { path: 'fix.txt', line: 1, user: { login: 'reviewer' }, created_at: at }
		pull.reviewComments.push({ ...line, id: 1, body: 'Rename this.', html_url: `${pull.html_url}#r1` })
		pull.reviewComments.push({ ...line, id: 2, body: 'And this.', html_url: `${pull.html_url}#r2`, in_reply_to_id: 1 })

		// Act
		const run = await runOnGateway(gateway, () =>
			reply({ repository: repositoryName, number: 13 })({ item: 'review-comment/2', text: 'Both done.' }),
		)
		await run.result

		// Assert
		expect(pull.reviewComments.at(-1)).toMatchObject({
			body: signed('Both done.', run.runId, ['reply', 'replied:review-comment/2']),
			in_reply_to_id: 1,
		})
	})

	test('leaves out an item GitHub will not take the 👀 on, such as a comment deleted since', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 14)
		pull.comments.push({
			id: 1,
			body: 'Why?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const items = [
			{ id: 'comment/99', url: `${pull.html_url}#c99`, body: 'Gone.', at: new Date().toISOString() },
			beingRead('comment', pull.comments[0]),
		]

		// Act
		const run = await runOnGateway(gateway, () => stubs.showBeingRead({ repository: repositoryName, number: 14, items }))

		// Assert
		await expect(run.result).resolves.toEqual({ shown: ['comment/1'], answered: [] })
		expect(reactionsOf(pull.comments[0])).toEqual(['eyes'])
	})

	test('fails showing items as being read when GitHub refuses the token, rather than say none was shown', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 17)
		pull.comments.push({
			id: 1,
			body: 'Why?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		api.failWith = (_method, requestPath) => (requestPath.endsWith('/reactions') ? 401 : undefined)

		// Act
		const run = await runOnGateway(gateway, () =>
			stubs.showBeingRead({ repository: repositoryName, number: 17, items: [beingRead('comment', pull.comments[0])] }),
		)

		// Assert
		await expect(run.result).rejects.toMatchObject({ name: 'GatewayCallError', transient: false })
		expect(pull.comments).toHaveLength(1)
	})

	test('keeps both of two answers given to one item at once', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 16)
		pull.comments.push({
			id: 1,
			body: 'Why?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 16 }
		// The first answer's edit waits until a second answer that didn't wait its turn would have looked for the reading reply too.
		const { promise: secondLooked, resolve: secondHasLooked } = Promise.withResolvers<undefined>()
		let edits = 0
		api.hold = (method, requestPath) =>
			method === 'PATCH' && requestPath.includes('/issues/comments/') && ++edits === 1 ? secondLooked : undefined
		const timer = setTimeout(() => {
			secondHasLooked(undefined)
		}, secondLook.to('ms'))
		onTestFinished(() => {
			clearTimeout(timer)
		})

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items: [beingRead('comment', pull.comments[0])] })
			const answer = reply(where)
			await Promise.all([answer({ item: 'comment/1', text: 'Because.' }), answer({ item: 'comment/1', text: 'Also, tests.' })])
		})
		await run.result

		// Assert
		expect(pull.comments.map((posted) => posted.body).toSorted()).toEqual(
			[
				signed(replyingTo(pull.comments[0], 'Because.'), run.runId, ['reply', 'answered:comment/1']),
				signed(replyingTo(pull.comments[0], 'Also, tests.'), run.runId, ['reply', 'replied:comment/1']),
				'Why?',
			].toSorted(),
		)
	})

	test('puts a plan in place of the reading reply and leaves the 👀 on, and answers after it in a reply of its own', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 17)
		pull.reviewComments.push({
			id: 1,
			body: 'Rename this.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#r1`,
			created_at: new Date().toISOString(),
			path: 'fix.txt',
			line: 1,
		})
		const where = { repository: repositoryName, number: 17 }
		const answer = reply(where)

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items: [beingRead('review-comment', pull.reviewComments[0])] })
			await answer({ item: 'review-comment/1', text: 'I will rename it to `login`.', stage: 'plan' })
			const whilePlanned = reactionsOf(pull.reviewComments[0])
			await answer({ item: 'review-comment/1', text: 'Renamed it to `login`.' })
			return whilePlanned
		})
		const whilePlanned = await run.result

		// Assert
		expect(whilePlanned).toEqual(['eyes'])
		expect(reactionsOf(pull.reviewComments[0])).toEqual([])
		expect(pull.reviewComments.map((posted) => [posted.body, posted.in_reply_to_id])).toEqual([
			['Rename this.', undefined],
			[signed('I will rename it to `login`.', run.runId, ['reply', 'answered:review-comment/1', 'planned:review-comment/1']), 1],
			[signed('Renamed it to `login`.', run.runId, ['reply', 'replied:review-comment/1']), 1],
		])
	})

	test('says an answer once, when it is given twice, as after a restart', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 18)
		pull.comments.push({
			id: 1,
			body: 'Why?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 18 }
		const answer = reply(where)

		// Act
		const run = await runOnGateway(gateway, async () => {
			await answer({ item: 'comment/1', text: 'Because.' })
			await answer({ item: 'comment/1', text: 'Because.' })
		})
		await run.result

		// Assert
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Why?',
			signed(replyingTo(pull.comments[0], 'Because.'), run.runId, ['reply', 'replied:comment/1']),
		])
	})

	test('says an answer once after a restart, also when the reviewer edited the item since', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 40)
		pull.comments.push({
			id: 1,
			body: 'Why?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 40 }
		const answer = reply(where)

		// Act
		const run = await runOnGateway(gateway, async () => {
			await answer({ item: 'comment/1', text: 'Because.' })
			const asked = pull.comments[0]
			if (asked !== undefined) asked.body = 'Why, though?'
			await answer({ item: 'comment/1', text: 'Because.' })
		})
		await run.result

		// Assert
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Why, though?',
			signed(
				withHeader(quoteHeader({ body: 'Why?', at: pull.comments[0]?.created_at ?? '', url: `${pull.html_url}#c1` }), 'Because.'),
				run.runId,
				['reply', 'replied:comment/1'],
			),
		])
	})

	test('says what it answers when the comment was deleted since', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 41)

		// Act
		const run = await runOnGateway(gateway, () => reply({ repository: repositoryName, number: 41 })({ item: 'comment/9', text: 'Done.' }))
		await run.result

		// Assert
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			signed(withHeader(deletedItemHeader('comment'), 'Done.'), run.runId, ['reply', 'replied:comment/9']),
		])
	})

	test('stops promptly when the run stops while GitHub never answers the read of the item a reply quotes', async () => {
		// Arrange
		const { api, gateway } = await connected()
		api.pullRequest(repositoryName, 42)
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (method, requestPath) => {
			if (method !== 'GET' || !requestPath.includes('/issues/comments/')) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, () => reply({ repository: repositoryName, number: 42 })({ item: 'comment/1', text: 'Done.' }))
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptly.to('ms'))
	})

	test('posts the answer after a plan once, when it is tried again after failing halfway', async () => {
		// Arrange
		const { api, gateway } = await connected(noRetry)
		const pull = api.pullRequest(repositoryName, 19)
		pull.comments.push({
			id: 1,
			body: 'Add a test.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 19 }
		// The answer's own reply is the second post, after the reading reply, and it fails once.
		const failingPost = 2
		let posts = 0
		api.hold = (method, requestPath) => {
			if (method !== 'POST' || !requestPath.endsWith('/comments')) return undefined
			posts += 1
			return posts === failingPost ? Promise.reject(new Error('Connection reset.')) : undefined
		}
		const answer = reply(where)

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items: [beingRead('comment', pull.comments[0])] })
			await answer({ item: 'comment/1', text: 'I will add one.', stage: 'plan' })
			const failed = await answer({ item: 'comment/1', text: 'Added one.' }).then(
				() => false,
				() => true,
			)
			await answer({ item: 'comment/1', text: 'Added one.' })
			return failed
		})
		const failed = await run.result

		// Assert
		expect(failed).toBe(true)
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Add a test.',
			signed(replyingTo(pull.comments[0], 'I will add one.'), run.runId, ['reply', 'answered:comment/1', 'planned:comment/1']),
			signed(replyingTo(pull.comments[0], 'Added one.'), run.runId, ['reply', 'replied:comment/1']),
		])
	})

	test('edits nothing when a plan is given again in the same words, and edits it in place in other words', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 20)
		pull.comments.push({
			id: 1,
			body: 'Add a test.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const where = { repository: repositoryName, number: 20 }
		let edits = 0
		api.hold = (method) => {
			if (method === 'PATCH') edits += 1
			return undefined
		}
		const answer = reply(where)

		// Act
		const run = await runOnGateway(gateway, async () => {
			await stubs.showBeingRead({ ...where, items: [beingRead('comment', pull.comments[0])] })
			await answer({ item: 'comment/1', text: 'I will add one.', stage: 'plan' })
			await answer({ item: 'comment/1', text: 'I will add one.', stage: 'plan' })
			const editsAfterSameWords = edits
			await answer({ item: 'comment/1', text: 'I will add two.', stage: 'plan' })
			return editsAfterSameWords
		})
		const editsAfterSameWords = await run.result

		// Assert
		expect(editsAfterSameWords).toBe(1)
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Add a test.',
			signed(replyingTo(pull.comments[0], 'I will add two.'), run.runId, [
				'reply',
				'seen:comment/1',
				'planned:comment/1',
				eyesKeyOf(pull.comments[0]),
			]),
		])
		expect(reactionsOf(pull.comments[0])).toEqual(['eyes'])
	})

	test('posts a plan of its own when the item was never shown as being read', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 21)
		pull.comments.push({
			id: 1,
			body: 'Add a test.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const answer = reply({ repository: repositoryName, number: 21 })

		// Act
		const run = await runOnGateway(gateway, async () => {
			await answer({ item: 'comment/1', text: 'I will add one.', stage: 'plan' })
			await answer({ item: 'comment/1', text: 'Added one.' })
		})
		await run.result

		// Assert
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Add a test.',
			signed(replyingTo(pull.comments[0], 'I will add one.'), run.runId, ['reply', 'answered:comment/1', 'planned:comment/1']),
			signed(replyingTo(pull.comments[0], 'Added one.'), run.runId, ['reply', 'replied:comment/1']),
		])
	})

	test('hands no item over again that was answered before the run started over', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 22)
		const at = new Date().toISOString()
		pull.comments.push({ id: 1, body: 'Why?', user: { login: 'reviewer' }, html_url: `${pull.html_url}#c1`, created_at: at })
		pull.comments.push({
			id: 2,
			body: signed('Because.', 'run-before', ['reply', 'answered:comment/1']),
			user: { login: api.self },
			html_url: `${pull.html_url}#c2`,
			created_at: at,
		})
		pull.comments.push({ id: 4, body: 'And the docs?', user: { login: 'reviewer' }, html_url: `${pull.html_url}#c4`, created_at: at })
		// An answer of its own, given when there was no reading reply to replace.
		pull.comments.push({
			id: 5,
			body: signed('Updated.', 'run-before', ['reply', 'replied:comment/4']),
			user: { login: api.self },
			html_url: `${pull.html_url}#c5`,
			created_at: at,
		})
		pull.comments.push({ id: 3, body: 'And the README?', user: { login: 'reviewer' }, html_url: `${pull.html_url}#c3`, created_at: at })
		const comments = vi.fn<(items: readonly { id: string }[]) => Promise<void>>(async () => {
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 22 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged' })
		expect(comments.mock.calls.map(([items]) => items.map((item) => item.id))).toEqual([['comment/3']])
	})

	test('stops promptly when the run stops while GitHub never answers the 👀', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 15)
		pull.comments.push({
			id: 1,
			body: 'Hm.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: new Date().toISOString(),
		})
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (_method, requestPath) => {
			if (!requestPath.endsWith('/reactions')) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}
		const comments = vi.fn(async () => undefined)

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 15 }, { comments }))
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptly.to('ms'))
		expect(comments).not.toHaveBeenCalled()
	})

	test('reports failed checks once per commit, and checksPass waits for them as findings', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const sha = shaOf('fix/7')
		const pull = api.pullRequest(repositoryName, 4, { head: { ref: 'fix/7', sha } })
		const checks = api.repository(repositoryName).checks
		checks.set(sha, [{ name: 'tests', status: 'in_progress', conclusion: null, html_url: null, output: { title: null, summary: null } }])
		const checksFailed = vi.fn<(failed: { sha: string }) => Promise<void>>(async () => {
			pull.state = 'closed'
			await Promise.resolve()
		})
		const complete = () => {
			checks.set(sha, [
				{
					name: 'tests',
					status: 'completed',
					conclusion: 'failure',
					html_url: 'https://ci.example/1',
					output: { title: 'Tests', summary: '2 failed' },
				},
				{ name: 'lint', status: 'completed', conclusion: 'success', html_url: null, output: { title: null, summary: null } },
			])
		}

		// Act
		const checked = await runOnGateway(gateway, ({ abortSignal }) => {
			setTimeout(complete, duration.of('100ms').to('ms'))
			return runCheck(checksPass({ repository: repositoryName, number: 4 }, { every: duration.of('1s') }), { abortSignal })
		})
		const findings = await checked.result
		const watched = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 4 }, { checksFailed }))
		await watched.result

		// Assert
		expect(findings).toEqual([{ source: 'check: tests', message: '2 failed (https://ci.example/1)' }])
		expect(toolCallsByPoll(checked.messages)).toEqual({
			descriptions: ['checks of team/app#4'],
			inPolls: ['githubPullRequest', 'githubChecks'],
			outsidePolls: [],
		})
		expect(checksFailed).toHaveBeenCalledTimes(1)
		expect(checksFailed.mock.calls[0]?.[0]).toMatchObject({
			sha,
			failures: [{ name: 'tests', summary: '2 failed', url: 'https://ci.example/1' }],
		})
	})

	test('reads an issue on the host after GitHub was unavailable for a moment', async () => {
		// Arrange
		const { api, gateway } = await connected(quickRetry)
		api.issue(repositoryName, 8, { title: 'Flaky network' })
		api.unavailableRequests = 2

		// Act
		const run = await runOnGateway(gateway, () => collect({ repository: repositoryName, number: 8 }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ number: 8, title: 'Flaky network' })
		expect(api.unavailableRequests).toBe(0)
	})

	test('keeps watching a pull request through an outage, and gives up once looks have failed for longer than it tolerates', async () => {
		// Arrange
		const { api, gateway } = await connected(noRetry)
		api.pullRequest(repositoryName, 9, { state: 'closed', merged: true })
		api.pullRequest(repositoryName, 10)
		const options = { every: duration.of('1s'), toleratedOutage: duration.of('3s') }

		// Act
		api.unavailableRequests = 3
		const outlived = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 9 }, {}, options))
		const outcome = await outlived.result
		api.unavailableRequests = 100
		const outlasted = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 10 }, {}, options))

		// Assert
		expect(outcome).toMatchObject({ state: 'merged' })
		expect(outlived.wakes).toBe(3)
		await expect(outlasted.result).rejects.toThrow('Service Unavailable')
		expect(outlasted.wakes).toBe(3)
	})

	test('looks at a pull request that has not changed with conditional reads, which GitHub does not count against the rate limit', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 18)
		const looksBeforeMerge = 3
		/** A look reads the pull request and its three lists. */
		const readsPerLook = 4
		let looks = 0
		// Used only to see each read of the pull request, and merge it after a few; nothing is held back.
		api.hold = (method, requestPath) => {
			if (method === 'GET' && requestPath.endsWith('/pulls/18') && ++looks > looksBeforeMerge) {
				pull.merged = true
				pull.state = 'closed'
			}
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 18 }, {}, { every: duration.of('1s') }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged' })
		// Every look after the first finds all it reads unchanged.
		expect(api.notModified).toBe((looksBeforeMerge - 1) * readsPerLook)
	})

	test('fails a watch at once on a failure that will not pass, such as a pull request that is gone', async () => {
		// Arrange
		const { gateway } = await connected(noRetry)

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 404 }, {}, { every: duration.of('1s') }))

		// Assert
		await expect(run.result).rejects.toMatchObject({ name: 'GatewayCallError', transient: false })
		expect(run.wakes).toBe(0)
	})

	test('waits for checks through an outage, and fails the check once looks have failed for longer than it tolerates', async () => {
		// Arrange
		const { api, gateway } = await connected(noRetry)
		const sha = shaOf('fix/11')
		api.pullRequest(repositoryName, 11, { head: { ref: 'fix/11', sha } })
		api
			.repository(repositoryName)
			.checks.set(sha, [
				{ name: 'tests', status: 'completed', conclusion: 'success', html_url: null, output: { title: null, summary: null } },
			])
		const options = { every: duration.of('1s'), toleratedOutage: duration.of('3s') }

		// Act
		api.unavailableRequests = 3
		const outlived = await runOnGateway(gateway, ({ abortSignal }) =>
			runCheck(checksPass({ repository: repositoryName, number: 11 }, options), { abortSignal }),
		)
		const findings = await outlived.result
		api.unavailableRequests = 100
		const outlasted = await runOnGateway(gateway, ({ abortSignal }) =>
			runCheck(checksPass({ repository: repositoryName, number: 11 }, options), { abortSignal }),
		)

		// Assert
		expect(findings).toEqual([])
		expect(outlived.wakes).toBe(3)
		await expect(outlasted.result).rejects.toThrow('Service Unavailable')
	})

	test('reuses a checkout for another branch, clones again over a broken one, and leaves another repository or a plain folder alone', async () => {
		// Arrange
		const { gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const first = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(first.directory, 'fix.txt'), 'fixed\n')
			await push(first)({ message: 'Fix' })
			const other = await checkout({ repository: repositoryName, branch: 'fix/8' })
			const otherHead = (await git(other.directory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
			const otherFiles = (await git(other.directory, 'ls-files')).split('\n')
			const back = await checkout({ repository: repositoryName, branch: 'fix/7' })
			const backHead = (await git(back.directory, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
			await rm(path.join(first.directory, '.git', 'HEAD'))
			const again = await checkout({ repository: repositoryName, branch: 'fix/7' })
			const againFiles = (await git(again.directory, 'ls-files')).split('\n')
			await git(again.directory, 'remote', 'set-url', 'origin', 'https://github.com/other/app.git')
			const refused = await checkout({ repository: repositoryName, branch: 'fix/7' }).then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			)
			const notes = workspace.folder('repositories/team/notes').location()
			await mkdir(notes, { recursive: true })
			await writeFile(path.join(notes, 'todo.md'), 'keep me\n')
			const kept = await checkout({ repository: 'team/notes', branch: 'fix/7' }).then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			)
			return { first, other, otherHead, otherFiles, backHead, againFiles, refused, kept }
		})
		const result = await run.result

		// Assert
		expect(result.other.directory).toBe(result.first.directory)
		expect(result.otherHead).toBe('fix/8')
		expect(result.otherFiles).toEqual(['README.md'])
		expect(result.backHead).toBe('fix/7')
		expect(result.againFiles).toEqual(['README.md', 'fix.txt'])
		expect(result.refused).toContain('holds a checkout of another repository')
		expect(result.kept).toContain("holds something that isn't a checkout")
		expect(await readFile(path.join(run.workspace, 'repositories', 'team', 'notes', 'todo.md'), 'utf8')).toBe('keep me\n')
	})

	test('puts repositories with the same name under other owners in folders of their own', async () => {
		// Arrange
		const { gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const ours = await checkout({ repository: repositoryName, branch: 'fix/7' })
			const theirs = await checkout({ repository: 'other/app', branch: 'fix/7' })
			return { ours, theirs }
		})
		const { ours, theirs } = await run.result

		// Assert
		expect(ours.directory).toBe(path.join(run.workspace, 'repositories', 'team', 'app'))
		expect(theirs.directory).toBe(path.join(run.workspace, 'repositories', 'other', 'app'))
	})

	test("hands a comment from the same second as the last look over once, and never the run's own reply", async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 5, { head: { ref: 'fix/7', sha: shaOf('fix/7') } })
		const at = new Date().toISOString()
		pull.comments.push({
			id: 1,
			body: 'Is this covered by a test?',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#c1`,
			created_at: at,
		})
		const comments = vi.fn<(items: readonly { id: string; body: string }[]) => Promise<void>>(async (items) => {
			if (comments.mock.calls.length === 1) {
				await reply({ repository: repositoryName, number: 5 })({ item: items[0]?.id ?? '', text: 'Yes, in fix.spec.mts.' })
				// Made while the first look was read, GitHub's clock says, so it sits in the same second as the look's last item.
				pull.comments.push({ id: 2, body: 'And documented?', user: { login: 'reviewer' }, html_url: `${pull.html_url}#c2`, created_at: at })
				return
			}
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 5 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged' })
		expect(comments.mock.calls.map((call) => call[0].map((item) => item.body))).toEqual([
			['Is this covered by a test?'],
			['And documented?'],
		])
		expect(pull.comments.map((posted) => posted.body)).toEqual([
			'Is this covered by a test?',
			signed(replyingTo(pull.comments[0], 'Yes, in fix.spec.mts.'), run.runId, ['reply', 'answered:comment/1']),
			'And documented?',
			signed(replyingTo(pull.comments[2], '👀 Reading...'), run.runId, ['reply', 'seen:comment/2', eyesKeyOf(pull.comments[2])]),
		])
		expect(pull.comments.map(reactionsOf)).toEqual([[], [], ['eyes'], []])
	})

	test('waits for the checks of a fresh commit to appear before judging them, and passes a repository without checks once they had time to', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const sha = shaOf('fix/7')
		const pull = api.pullRequest(repositoryName, 6, { head: { ref: 'fix/7', sha } })
		const failed: FakeCheckRun[] = [
			{ name: 'tests', status: 'completed', conclusion: 'failure', html_url: null, output: { title: null, summary: '1 failed' } },
		]
		const looksBeforeChecksAppear = 3
		let looks = 0
		vi.spyOn(api.repository(repositoryName).checks, 'get').mockImplementation(() =>
			++looks > looksBeforeChecksAppear ? failed : undefined,
		)
		const checksFailed = vi.fn<(failed: { sha: string }) => Promise<void>>(async () => {
			pull.state = 'closed'
			await Promise.resolve()
		})
		const noChecks = api.pullRequest('team/quiet', 1, { head: { ref: 'fix/1', sha: shaOf('fix/1') } })

		// Act
		const checked = await runOnGateway(gateway, ({ abortSignal }) =>
			runCheck(checksPass({ repository: repositoryName, number: 6 }, { every: duration.of('1s') }), { abortSignal }),
		)
		const findings = await checked.result
		const looksForFindings = looks
		const watched = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 6 }, { checksFailed }))
		await watched.result
		const quiet = await runOnGateway(gateway, ({ abortSignal }) =>
			runCheck(
				checksPass({ repository: 'team/quiet', number: noChecks.number }, { every: duration.of('1s'), appearWithin: duration.of('0s') }),
				{
					abortSignal,
				},
			),
		)

		// Assert
		expect(findings).toEqual([{ source: 'check: tests', message: '1 failed' }])
		expect(looksForFindings).toBe(looksBeforeChecksAppear + 1)
		expect(checksFailed).toHaveBeenCalledTimes(1)
		await expect(quiet.result).resolves.toEqual([])
	})
})
