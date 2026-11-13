/** A pull or merge request as `describe` and `decideOnEdit` read it, whichever forge it's on. */
export interface ChangeRequest {
	/** The repository as the forge names it. */
	readonly repository: string
	/** The number it goes by in its repository: a pull request's number, a merge request's iid. */
	readonly number: number
	readonly url: string
	readonly state: 'open' | 'closed'
	readonly head: { readonly branch: string }
	/** The branch it merges into. */
	readonly base: string
	readonly title: string
	/** The description, without the connector's footer. */
	readonly description: string
	/** The commit the description was written for, when the connector wrote it. */
	readonly describedSha?: string | undefined
}

/** Names a pull or merge request: its repository and number. */
export interface ChangeRequestRef {
	readonly repository: string
	readonly number: number
}

/** How a forge's connector names what it does, in prompts, tool names and errors. */
export interface ForgeTerms {
	/** The forge, such as `GitHub`. */
	readonly forge: string
	/** What it calls a change to merge: `pull request` or `merge request`. */
	readonly request: string
	/** What the connector's tool names start with, such as `github`. */
	readonly toolPrefix: string
}

/** `pull request` as `PullRequest`, for a tool name. */
export function pascalCase(words: string): string {
	return words
		.split(' ')
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join('')
}
