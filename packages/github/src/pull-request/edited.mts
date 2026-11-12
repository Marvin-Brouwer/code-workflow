import { input } from '@mesh-flow/core'
import type { PullRequest } from './pull-request.mts'
import { sameText, textInPrompt, type PullRequestContent } from './pull-request-text.mts'

/**
 * Whether to leave `current` as it is: someone edited it after `describe` read it, so the new text
 * would overwrite their edit, and the person said no to that. Nothing is asked when the pull request
 * still says what the new text was written from, or says the new text already, or is closed.
 */
export async function keepsEdit(current: PullRequest, content: PullRequestContent): Promise<boolean> {
	const { basedOn } = content
	if (basedOn === undefined || current.state === 'closed' || sameText(current, basedOn) || sameText(current, content)) return false
	const { overwrite } = await input(
		`${current.url} was edited while its new title and description were written. Overwrite the edit?\n\nThe new text:\n${textInPrompt(content)}`,
		{ overwrite: input.yesNo('Yes writes the new text over the edit; no keeps the pull request as it is now.') },
	)
	return !overwrite
}
