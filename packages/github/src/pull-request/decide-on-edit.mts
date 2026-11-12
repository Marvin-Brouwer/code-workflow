import { input } from '@mesh-flow/core'
import type { PullRequest } from './pull-request.mts'
import { sameText, textInPrompt, type PullRequestContent, type PullRequestText } from './pull-request-text.mts'

/** What `decideOnEdit` decided: the pull request to leave as it is, or the text it said when it was last looked at. */
export type EditDecision = { readonly kept: PullRequest } | { readonly seen?: PullRequestText }

/**
 * Whether to leave the pull request as it is: someone edited it after the new text was written
 * from it, and the person said no to overwriting their edit. Nothing is asked when it still says
 * what the new text was written from, or says the new text already, or is closed. A person may
 * take long to answer, so after a yes it reads the pull request again, and asks once more when it
 * was edited again meanwhile. Otherwise it gives the text the pull request said when it was last
 * looked at, for the write to check against.
 *
 * The question waits on the run's signal, as every `input` does.
 */
export async function decideOnEdit(
	read: () => Promise<PullRequest>,
	content: PullRequestContent,
	lastSeen: PullRequestText | undefined,
): Promise<EditDecision> {
	let seen = lastSeen
	while (seen !== undefined) {
		const current = await read()
		if (current.state === 'closed' || sameText(current, seen) || sameText(current, content)) return { seen }
		const { overwrite } = await input(editQuestion(current, content), {
			overwrite: input.yesNo('Yes writes the new text over the edit; no keeps the pull request as it is now.'),
		})
		if (!overwrite) return { kept: current }
		seen = { title: current.title, description: current.description }
	}
	return {}
}

/** What the person is asked: whether the new text may overwrite the edit on `current`. */
function editQuestion(current: PullRequest, content: PullRequestContent): string {
	return `${current.url} was edited while its new title and description were written. Overwrite the edit?\n\nThe new text:\n${textInPrompt(content)}`
}
