import { describeApp, defineMeshFlow, image, workflow } from '@mesh-flow/core'
import { describe, expect, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import { github } from '../src/_module/hooks.mts'
import { issue } from '../src/issue/issue.mts'

/** A delivery of the `issues` event for label `name`. */
function labeled(name: string) {
	return {
		action: 'labeled',
		label: { name },
		issue: { number: 7, title: 'Login fails', html_url: 'https://github.com/team/app/issues/7' },
		repository: { full_name: 'team/app' },
		sender: { login: 'reporter' },
	}
}

describe('github hooks', () => {
	test('issueLabeled fits only the label it was made for', () => {
		// Arrange
		const schema = github.issueLabeled('ai-fix')

		// Act
		const fits = schema.safeParse(labeled('ai-fix'))
		const other = schema.safeParse(labeled('bug'))
		const any = github.issueLabeled().safeParse(labeled('bug'))

		// Assert
		expect(fits.success).toBe(true)
		expect(other.success).toBe(false)
		expect(any.success).toBe(true)
	})

	test("onIssueLabeled is a webhook with GitHub's signature and delivery header that maps the event to the issue", async () => {
		// Arrange
		const fixIssue = workflow('fix-issue', { issue }, async () => undefined)

		// Act
		const trigger = github.onIssueLabeled(fixIssue, 'ai-fix')
		const parameters = await trigger.schema.parseAsync(labeled('ai-fix'))

		// Assert
		expect(trigger).toMatchObject({
			kind: 'webhook',
			id: 'fix-issue-labeled-ai-fix',
			signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
			deliveryHeader: 'x-github-delivery',
		})
		expect(parameters).toEqual({ issue: { repository: 'team/app', number: 7 } })
		expect(trigger.schema.safeParse(labeled('bug')).success).toBe(false)
	})

	test('an app lists it as a webhook trigger with the filter in the payload schema', () => {
		// Arrange
		const fixIssue = workflow('fix-issue-listed', { issue }, async () => undefined)
		const app = defineMeshFlow({ sandbox: image({ name: 'node:26-bookworm' }), workflows: [github.onIssueLabeled(fixIssue, 'ai-fix')] })

		// Act
		const described = describeApp(app, [fixIssue])

		// Assert
		expect(described.triggers).toMatchObject([{ kind: 'webhook', id: 'fix-issue-listed-labeled-ai-fix', workflow: 'fix-issue-listed' }])
		expect(JSON.stringify(described.triggers[0])).toContain('"const":"ai-fix"')
	})

	test('only compiles for a workflow that takes the issue', () => {
		// Arrange
		const takesIssue = workflow('takes-issue', { issue, verbose: z.boolean().optional() }, async () => undefined)
		const takesNumber = workflow('takes-number', { issue: z.number() }, async () => undefined)
		const needsMore = workflow('needs-more', { issue, branch: z.string() }, async () => undefined)

		// Act
		const trigger = github.onIssueLabeled(takesIssue, 'ai-fix')

		// Assert
		expectTypeOf(trigger.kind).toEqualTypeOf<'webhook'>()
		// @ts-expect-error The issue is a number there, not { repository, number }.
		github.onIssueLabeled(takesNumber, 'ai-fix')
		// @ts-expect-error The workflow needs a branch too, which the event doesn't give.
		github.onIssueLabeled(needsMore, 'ai-fix')
	})

	test('the review event schemas take what GitHub sends', () => {
		// Arrange
		const review = {
			action: 'submitted',
			review: {
				id: 1,
				body: null,
				state: 'approved',
				html_url: 'https://github.com/team/app/pull/3#pullrequestreview-1',
				user: { login: 'reviewer' },
			},
			pull_request: { number: 3, title: 'Fix', html_url: 'https://github.com/team/app/pull/3' },
			repository: { full_name: 'team/app' },
		}
		const lineComment = {
			action: 'created',
			comment: {
				id: 2,
				body: 'Rename this.',
				path: 'fix.txt',
				line: 1,
				html_url: 'https://github.com/team/app/pull/3#r2',
				user: { login: 'reviewer' },
			},
			pull_request: { number: 3, title: 'Fix', html_url: 'https://github.com/team/app/pull/3' },
			repository: { full_name: 'team/app' },
		}

		// Act
		const parsedReview = github.pullRequestReviewSubmitted.safeParse(review)
		const parsedComment = github.pullRequestReviewCommentCreated.safeParse(lineComment)

		// Assert
		expect(parsedReview.success).toBe(true)
		expect(parsedComment.success).toBe(true)
	})
})
