import { describe, expect, test } from 'vitest'
import { deliveryHeader, mergeRequestEvent, mergeRequestNote, pipelineEvent, signature, triggerOptions } from '../src/hooks.mts'

const project = { id: 12, path_with_namespace: 'team/backend/api', web_url: 'https://gitlab.example/team/backend/api' }
const mergeRequest = {
	iid: 3,
	title: 'Keep the session',
	url: 'https://gitlab.example/team/backend/api/-/merge_requests/3',
	source_branch: 'feature/PROJ-7',
	target_branch: 'main',
	state: 'merged',
}

/** A note event on a noteable of `noteableType`. */
function note(noteableType: string) {
	return {
		object_kind: 'note',
		user: { username: 'reviewer' },
		project,
		object_attributes: { id: 9, note: 'Rename this.', noteable_type: noteableType, url: `${mergeRequest.url}#note_9` },
		merge_request: mergeRequest,
	}
}

describe('hooks', () => {
	test("checks GitLab's secret token in its own header, and names deliveries by GitLab's idempotency key", () => {
		// Act
		const options = triggerOptions

		// Assert
		expect(options).toEqual({ signature, deliveryHeader })
		expect(signature).toEqual({ scheme: 'secret-header', header: 'x-gitlab-token' })
		expect(deliveryHeader).toBe('idempotency-key')
	})

	test('takes a merge request event of the action asked for, and no other', () => {
		// Arrange
		const merged = {
			object_kind: 'merge_request',
			user: { username: 'reviewer' },
			project,
			object_attributes: { ...mergeRequest, action: 'merge' },
		}

		// Act
		const onMerge = mergeRequestEvent('merge').safeParse(merged)
		const onOpen = mergeRequestEvent('open').safeParse(merged)

		// Assert
		expect(onMerge.success).toBe(true)
		expect(onOpen.success).toBe(false)
	})

	test('takes a note on a merge request, and not one on an issue', () => {
		// Arrange

		// Act
		const onMergeRequest = mergeRequestNote.safeParse(note('MergeRequest'))
		const onIssue = mergeRequestNote.safeParse(note('Issue'))

		// Assert
		expect(onMergeRequest.success).toBe(true)
		expect(onIssue.success).toBe(false)
	})

	test('takes a pipeline event of the status asked for', () => {
		// Arrange
		const failed = { object_kind: 'pipeline', project, object_attributes: { id: 5, ref: 'main', sha: 'a'.repeat(40), status: 'failed' } }

		// Act
		const onFailure = pipelineEvent('failed').safeParse(failed)
		const onSuccess = pipelineEvent('success').safeParse(failed)

		// Assert
		expect(onFailure.success).toBe(true)
		expect(onSuccess.success).toBe(false)
	})
})
