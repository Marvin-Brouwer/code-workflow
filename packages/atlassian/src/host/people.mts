import { isApiError, isNetworkError, isSchemaMismatchError } from 'jira.js'
import { mentionsIn } from './html-to-markdown.mts'
import { mentionIdOf, mentionKey, type MentionRef, type Person } from './mention.mts'

/** What a site says of a person: their display name and email, as far as it shows them. */
export interface UserDetails {
	readonly name?: string | undefined
	readonly email?: string | undefined
}

/** Asks the site who a mention names; `undefined` when it can't say. */
export type UserLookup = (mention: MentionRef, abortSignal: AbortSignal) => Promise<UserDetails | undefined>

/** How many people are asked about at once: a few, so many mentions don't take long, nor hit the site's rate limit. */
const lookupsAtOnce = 4

/**
 * The people the rich text mentions, each asked about once: their name, the email the site shows
 * and their id. A person the site can't tell about keeps the name and id the link holds; Cloud
 * leaves out the email of people who keep it private. A stop is thrown.
 */
export async function peopleIn(
	richTexts: readonly (string | null | undefined)[],
	lookup: UserLookup,
	abortSignal: AbortSignal,
): Promise<Map<string, Person>> {
	const mentioned = new Map(richTexts.flatMap(mentionsIn).map((mention) => [mentionKey(mention), mention]))
	const people = new Map<string, Person>()
	const queue = [...mentioned]
	while (queue.length > 0) {
		const round = queue.splice(0, lookupsAtOnce)
		const answers = await Promise.all(round.map(([, mention]) => askSite(lookup, mention, abortSignal)))
		round.forEach(([key, mention], index) => {
			people.set(key, { name: answers[index]?.name ?? mention.name, email: answers[index]?.email, id: mentionIdOf(mention) })
		})
	}
	return people
}

/**
 * Asks the site about one person. An answer the site gives instead, such as a 404 for someone
 * removed or a 403 without permission to browse users, and a dropped connection mean it can't say:
 * the mention keeps what its link holds, rather than failing the read of the issue or page.
 */
async function askSite(lookup: UserLookup, mention: MentionRef, abortSignal: AbortSignal): Promise<UserDetails | undefined> {
	if (mentionIdOf(mention) === undefined) return undefined
	try {
		return await lookup(mention, abortSignal)
	} catch (error) {
		abortSignal.throwIfAborted()
		if (isApiError(error) || isNetworkError(error) || isSchemaMismatchError(error)) return undefined
		throw error
	}
}
