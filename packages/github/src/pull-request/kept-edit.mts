import { input } from '@mesh-flow/core'
import type { PullRequest } from './pull-request.mts'
import { sameText, textInPrompt, type PullRequestContent, type PullRequestText } from './pull-request-text.mts'

/**
 * The pull request to leave as it is, when someone edited it after `describe` read it and the
 * person said no to overwriting their edit; nothing when the new text may be written. Nothing is
 * asked when the pull request still says what the new text was written from, or says the new text
 * already, or is closed. A person may take long to answer, so after a yes it reads the pull request
 * again, and asks once more when it was edited again meanwhile.
 *
 * The question waits on the run's signal, as every `input` does.
 */
export async function keptEdit(read: () => Promise<PullRequest>, content: PullRequestContent): Promise<PullRequest | undefined> {
	let seen: PullRequestText | undefined = content.basedOn
	while (seen !== undefined) {
		const current = await read()
		if (current.state === 'closed' || sameText(current, seen) || sameText(current, content)) return undefined
		const { overwrite } = await input(editQuestion(current, content), {
			overwrite: input.yesNo('Yes writes the new text over the edit; no keeps the pull request as it is now.'),
		})
		if (!overwrite) return current
		seen = { title: current.title, description: current.description }
	}
	return undefined
}

/** What the person is asked: whether the new text may overwrite the edit on `current`. */
function editQuestion(current: PullRequest, content: PullRequestContent): string {
	return `${current.url} was edited while its new title and description were written. Overwrite the edit?\n\nThe new text:\n${textInPrompt(content)}`
}
