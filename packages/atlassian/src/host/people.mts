import { mentionsIn, type MentionRef, type Person } from './html-to-markdown.mts'

/** What a site says of a person: their display name and email, as far as it shows them. */
export interface UserDetails {
	readonly name?: string | undefined
	readonly email?: string | undefined
}

/** Asks the site who a mention names; `undefined` when it can't say. */
export type UserLookup = (mention: MentionRef, abortSignal: AbortSignal) => Promise<UserDetails | undefined>

/** One key per person a mention can name, by account id, username or, without either, the name. */
export function mentionKey(mention: MentionRef): string {
	if (mention.accountId !== undefined) return `account:${mention.accountId}`
	return mention.username === undefined ? `name:${mention.name}` : `user:${mention.username}`
}

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
	const people = new Map<string, Person>()
	for (const mention of richTexts.flatMap(mentionsIn)) {
		const key = mentionKey(mention)
		if (people.has(key)) continue
		const id = mention.accountId ?? mention.username
		const details =
			id === undefined
				? undefined
				: await lookup(mention, abortSignal).catch((error: unknown) => {
						abortSignal.throwIfAborted()
						if (error instanceof Error) return undefined
						throw error
					})
		people.set(key, { name: details?.name ?? mention.name, email: details?.email, id })
	}
	return people
}
