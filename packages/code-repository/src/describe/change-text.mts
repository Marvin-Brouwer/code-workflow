import { z } from 'zod'
import { withUnixLineBreaks } from '../line-breaks.mts'
import type { CodeHostTerms } from './change-request.mts'
import { fenced } from './fenced.mts'

/** The title and description of a pull or merge request. */
export interface ChangeText {
	readonly title: string
	readonly description: string
}

/**
 * Room kept in a description for the footer the connector adds: the run's signature, its markers
 * and what the change closes take a few hundred characters, and this leaves plenty to spare.
 */
export const footerRoomCharacters = 5_536

/** A code host's limits on a title and a description, and what it calls the change. */
export interface ChangeTextLimits {
	/** The longest title the code host takes. */
	readonly maxTitleCharacters: number
	/** The longest description the code host takes. The agent gets less: {@link footerRoomCharacters} is kept for the footer. */
	readonly maxDescriptionCharacters: number
	/** What the code host calls things: its `request` names the change in the field descriptions. */
	readonly terms: CodeHostTerms
}

/**
 * What the agent of `describe` finishes with: the title and the description, within the code host's
 * limits, so a text that is too long goes back to the agent rather than failing the run on the code host,
 * and on every rerun after, since the loop keeps its result.
 */
export function changeTextSchema(limits: ChangeTextLimits) {
	return z.object({
		title: z
			.string()
			.min(1)
			.max(limits.maxTitleCharacters)
			.regex(/^[^\r\n]+$/, 'Write the title on one line.')
			.describe(`The ${limits.terms.request}'s title, one line`),
		description: z
			.string()
			.min(1)
			.max(limits.maxDescriptionCharacters - footerRoomCharacters)
			.describe(`The ${limits.terms.request}'s description, in Markdown`),
	})
}

/** A pull or merge request the text was written from, by repository and number, and its title and description then. */
export interface BasedOn extends ChangeText {
	readonly repository: string
	readonly number: number
}

/**
 * What a pull or merge request is opened or updated with: its text, the commit the text was written
 * for and what it closes. `describe` resolves to one.
 */
export interface ChangeContent<Closes = unknown> extends ChangeText {
	/** The commit the description was written for. Default when opening: the pushed head. */
	readonly describedSha?: string
	/** What the change closes when it merges, such as an issue, which the footer names. */
	readonly closes?: Closes
	/**
	 * The pull or merge request the new text was written from, and what it said then. Opening one
	 * updates that one rather than open another. When it says something else by the time the text is
	 * written, someone edited it meanwhile, and the person is asked before the edit is overwritten.
	 */
	readonly basedOn?: BasedOn
}

/** Whether two texts say the same, whichever line breaks the descriptions were saved with. */
export function sameText(one: ChangeText, other: ChangeText): boolean {
	return one.title === other.title && normalizedBody(one.description) === normalizedBody(other.description)
}

/** Text as a code host gives it back once written, a description or a comment: with `\n` line breaks and without trailing ones. */
export function normalizedBody(text: string): string {
	return withUnixLineBreaks(text).trimEnd()
}

/** A title and description as a prompt takes them, the description fenced. */
export function textInPrompt(text: ChangeText): string {
	return `Title: ${text.title}\nDescription:\n${fenced(text.description)}`
}
