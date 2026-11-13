import { commentMarker, isMarked } from '@mesh-flow/code-repository'
import { notFound, replyKey, type OwnReply, type PostedReply, type ReviewComments } from '@mesh-flow/code-repository/host'
import { z } from 'zod'
import type { ReviewItem } from '../tools/merge-request-tools.mts'
import { GitlabRequestError, isGone, projectSegment, type GitlabClient } from './api.mts'

/** The kinds of item a review on GitLab brings: a comment on a line, or one on the merge request. */
export type ReviewItemKind = ReviewItem['kind']

/** A note as GitLab lists it in a discussion. */
const ApiNote = z.object({
	id: z.int(),
	type: z.string().nullable().optional(),
	body: z.string(),
	author: z.object({ username: z.string() }),
	created_at: z.string(),
	system: z.boolean(),
	position: z.object({ new_path: z.string().nullable().optional(), new_line: z.int().nullable().optional() }).nullable().optional(),
})
export type ApiNote = z.infer<typeof ApiNote>

/** A discussion on a merge request: a thread of notes, or one note on its own. */
const ApiDiscussion = z.object({ id: z.string(), notes: z.array(ApiNote) })
export type ApiDiscussion = z.infer<typeof ApiDiscussion>

const AwardEmoji = z.object({ id: z.int(), name: z.string(), user: z.object({ username: z.string() }) })
const CurrentUser = z.object({ username: z.string() })
const Note = z.object({ id: z.int() })

/** The emoji that says a note is being read. */
const beingReadEmoji = 'eyes'

/** What the reply that says an item is being read says. It goes in the item's thread, so it needs no link. */
export const readingNote = '👀 Reading...'

/** Where merge request `number` of `project` is on the API. */
export function mergeRequestPath(project: string, number: number): string {
	return `${projectSegment(project)}/merge_requests/${String(number)}`
}

/** Where a note is seen on GitLab: on the merge request's page, at the note. */
export function noteUrl(siteUrl: string, project: string, number: number, noteId: number): string {
	return `${siteUrl}/${project}/-/merge_requests/${String(number)}#note_${String(noteId)}`
}

/** The item id an agent sees for a note: `note/12`. */
export function noteItemId(noteId: number): string {
	return `note/${String(noteId)}`
}

/** The note's id in an item id. */
export function noteIdOf(item: string): number {
	return z.coerce.number().int().parse(item.split('/')[1])
}

/** The discussions of a merge request, with every note in each. */
export function discussionsOf(client: GitlabClient, project: string, number: number): Promise<ApiDiscussion[]> {
	return client.all(`${mergeRequestPath(project, number)}/discussions`, ApiDiscussion)
}

/** The notes of a merge request a reviewer wrote: neither GitLab's system notes nor this package's own. */
export function reviewItemsOf(discussions: readonly ApiDiscussion[], siteUrl: string, project: string, number: number): ReviewItem[] {
	return discussions.flatMap(({ notes }) =>
		notes
			.filter((note) => !note.system && !isMarked(note.body))
			.map((note) => {
				const first = notes[0]
				const position = note.position ?? undefined
				return {
					id: noteItemId(note.id),
					kind: note.type === 'DiffNote' ? ('diff-note' as const) : ('note' as const),
					author: note.author.username,
					body: note.body,
					url: noteUrl(siteUrl, project, number, note.id),
					at: new Date(note.created_at).toISOString(),
					...(position?.new_path === null || position?.new_path === undefined ? {} : { path: position.new_path }),
					...(position?.new_line === null || position?.new_line === undefined ? {} : { line: position.new_line }),
					...(first === undefined || first.id === note.id ? {} : { inReplyTo: noteItemId(first.id) }),
				}
			}),
	)
}

/**
 * Where the connector answers review items on merge request `number`: always in the thread of the
 * item, which GitLab starts when the first reply goes to a note on its own. Each note takes award
 * emoji, so every item gets the 👀. The discussions are read once per value, so make one per call.
 */
export function mergeRequestNotes(client: GitlabClient, project: string, number: number): ReviewComments<ReviewItemKind, string> {
	const where = mergeRequestPath(project, number)
	let discussions: Promise<ApiDiscussion[]> | undefined
	const listed = () => (discussions ??= discussionsOf(client, project, number))
	let self: Promise<string> | undefined
	const username = () => (self ??= client.request('GET', '/user', CurrentUser).then((user) => user.username))
	const posted = (id: number): PostedReply => ({ id, url: noteUrl(client.url, project, number, id) })
	return Object.freeze<ReviewComments<ReviewItemKind, string>>({
		async ownReplies() {
			return (await listed()).flatMap(({ notes }) =>
				notes.flatMap((note): OwnReply[] =>
					note.body.includes(commentMarker(replyKey)) ? [{ id: note.id, body: note.body, url: posted(note.id).url }] : [],
				),
			)
		},
		async react(_kind, noteId) {
			const awards = `${where}/notes/${String(noteId)}/award_emoji`
			// GitLab refuses a second 👀 from the same user: one there already is this one.
			const [existing, me] = await Promise.all([client.all(awards, AwardEmoji), username()])
			const own = existing.find((award) => award.name === beingReadEmoji && award.user.username === me)
			if (own !== undefined) return own.id
			return (await client.request('POST', awards, AwardEmoji, { body: { name: beingReadEmoji } })).id
		},
		async unreact(_kind, noteId, reaction) {
			// Best effort: the reviewer may have deleted the note, and the answer matters more.
			await client.send('DELETE', `${where}/notes/${String(noteId)}/award_emoji/${String(reaction)}`).catch(() => undefined)
		},
		async threadOf(_kind, noteId) {
			const discussion = (await listed()).find(({ notes }) => notes.some((note) => note.id === noteId))
			if (discussion === undefined) throw new GitlabRequestError(`Note ${String(noteId)} isn't on ${project}!${String(number)}.`, notFound)
			return discussion.id
		},
		isGone,
		async post(_kind, thread, body) {
			const path = thread === undefined ? `${where}/notes` : `${where}/discussions/${encodeURIComponent(thread)}/notes`
			return posted((await client.request('POST', path, Note, { body: { body } })).id)
		},
		async edit(_kind, noteId, body) {
			return posted((await client.request('PUT', `${where}/notes/${String(noteId)}`, Note, { body: { body } })).id)
		},
	})
}
