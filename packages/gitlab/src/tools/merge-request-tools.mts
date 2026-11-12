import { BranchName, Sha } from '@mesh-flow/forge'
import { z } from 'zod'
import { ProjectPath } from '../project-path.mts'

/** Names a merge request: its project and its iid, the number it goes by in the project, as in `!7`. */
export const MergeRequestRef = z.object({
	repository: ProjectPath,
	number: z.int().positive(),
})
export type MergeRequestRef = z.infer<typeof MergeRequestRef>

/** A merge request as GitLab has it. */
export const MergeRequestData = MergeRequestRef.extend({
	title: z.string(),
	url: z.url(),
	state: z.enum(['open', 'closed']),
	merged: z.boolean(),
	head: z.object({ branch: BranchName, sha: Sha }),
	base: BranchName,
	/** The description, without the footer when this package wrote it. */
	description: z.string(),
	/** The commit the description was written for, when this package wrote it. */
	describedSha: Sha.optional(),
	/** For a merged merge request: the commit the merge left on the target branch. */
	mergedSha: Sha.optional(),
})
export type MergeRequestData = z.infer<typeof MergeRequestData>

/** The id of a review item: a note, by GitLab's id, as an agent sees and replies to it. */
export const ReviewItemId = z.string().regex(/^note\/\d+$/, 'Use the id of a review item, such as note/12.')
export type ReviewItemId = z.infer<typeof ReviewItemId>

/**
 * Something a reviewer said on a merge request: a comment on a line of the diff (`diff-note`) or on
 * the merge request itself (`note`). Either can start a thread or reply in one.
 */
export const ReviewItem = z.object({
	id: ReviewItemId,
	kind: z.enum(['diff-note', 'note']),
	author: z.string(),
	body: z.string(),
	url: z.url(),
	at: z.iso.datetime({ offset: true }),
	/** For a comment on a line: where. */
	path: z.string().optional(),
	line: z.int().optional(),
	/** For a reply in a thread: the thread's first comment. */
	inReplyTo: ReviewItemId.optional(),
})
export type ReviewItem = z.infer<typeof ReviewItem>

/** What a merge request closes when it merges: an issue in the project (`#7`), in another (`group/project#7`), or a Jira issue (`PROJ-7`). */
export const ClosingReference = z.string().regex(/^(([\w.-]+\/)+[\w.-]+)?#\d+$|^[A-Z][A-Z0-9_]+-[1-9]\d*$/)

/**
 * Opens the merge request on the host. When the branch already has an open one, updates its title
 * and description, unless it was already described for this commit.
 */
export const openMergeRequest = {
	name: 'gitlabOpenMergeRequest',
	description:
		'Opens a merge request on GitLab; when the branch already has an open one, updates its title and description, unless it was already described for this commit',
	input: z.object({
		repository: ProjectPath,
		head: BranchName,
		base: BranchName,
		title: z.string().min(1),
		body: z.string(),
		describedSha: Sha,
		closes: ClosingReference.optional(),
	}),
	output: MergeRequestData,
}

/**
 * Why `updateMergeRequest` wrote nothing. `closed`: a closed merge request keeps its text.
 * `unchanged`: it already said this. `edited`: someone edited it since it was last looked at.
 */
export const UpdateSkip = z.enum(['closed', 'unchanged', 'edited'])
export type UpdateSkip = z.infer<typeof UpdateSkip>

/** Gives an open merge request on the host a new title and description; a closed one is left as it is. */
export const updateMergeRequest = {
	name: 'gitlabUpdateMergeRequest',
	description: "Changes a merge request's title and description on GitLab",
	input: MergeRequestRef.extend({
		title: z.string().min(1),
		body: z.string(),
		describedSha: Sha.optional(),
		closes: ClosingReference.optional(),
		/** What the merge request said when it was last looked at: when it says something else now, someone edited it since, and nothing is written. */
		seen: z.object({ title: z.string(), description: z.string() }).optional(),
	}),
	/** With `skipped` when nothing was written. */
	output: MergeRequestData.extend({ skipped: UpdateSkip.optional() }),
}

/** Finds on the host the open merge request of a branch onto a target branch, when it has one. */
export const findMergeRequest = {
	name: 'gitlabFindMergeRequest',
	description: 'Finds the open merge request of a branch on GitLab',
	input: z.object({ repository: ProjectPath, head: BranchName, base: BranchName }),
	output: MergeRequestData.nullable(),
}

/** Reads the merge request on the host. */
export const getMergeRequest = {
	name: 'gitlabMergeRequest',
	description: 'Reads a merge request on GitLab',
	input: MergeRequestRef,
	output: MergeRequestData,
}

/**
 * Lists on the host what was said on the merge request at or after `since`, oldest first. Notes
 * this package posted are left out by their marker, never by author: the token may well be the
 * reviewer's own. So are GitLab's system notes, such as "added 1 commit". An item at the same
 * moment as `since` comes again, so the caller keeps the ids it has handled.
 */
export const reviewActivity = {
	name: 'gitlabReviewActivity',
	description: 'Lists what reviewers said on a merge request since a moment, oldest first',
	input: MergeRequestRef.extend({ since: z.iso.datetime({ offset: true }).optional() }),
	output: z.object({
		items: z.array(ReviewItem),
		/** The moment of the latest item seen so far: the `since` of the next call. Absent until an item was seen. */
		until: z.iso.datetime({ offset: true }).optional(),
	}),
}

/**
 * Whether a reply is a plan, what will be done before anything changes, or the answer: to a
 * question, or what was done.
 */
export const ReplyStage = z.enum(['plan', 'answer'])
export type ReplyStage = z.infer<typeof ReplyStage>

/** A note that was posted or edited. */
export const PostedNote = z.object({ id: z.int(), url: z.url() })

/** A reply that found its item gone. */
const GoneReply = z.object({ gone: z.literal(true) })

/** What came of a reply: the note posted or edited, or that the item is gone, deleted since it was read. */
export const ReplyOutcome = z.union([PostedNote, GoneReply])
export type ReplyOutcome = z.infer<typeof ReplyOutcome>

/** Whether a reply found its item gone: a note deleted since it was read. */
export function isGoneReply(outcome: ReplyOutcome): outcome is z.infer<typeof GoneReply> {
	return 'gone' in outcome
}

/**
 * Replies on the host in the item's thread, with a footer naming the run and a marker in the body
 * so the reply is never listed as a reviewer's item. The first answer to an item replaces the
 * "👀 Reading..." reply that showed it was being read, and takes the 👀 off the item. A plan
 * replaces the reading reply too but leaves the 👀 on, and the answer after a plan is a reply of its
 * own under it, so the reviewer is notified of it. Replies to one item go one at a time.
 */
export const replyToReviewItem = {
	name: 'gitlabReply',
	description: "Replies to a review item on a merge request, in the item's thread",
	input: MergeRequestRef.extend({ item: ReviewItemId, body: z.string().min(1), stage: ReplyStage.optional() }),
	output: ReplyOutcome,
}

/**
 * Shows the reviewer on the host that review items are being read: a 👀 on the note, and a
 * "👀 Reading..." reply in its thread that the first answer to the item replaces. Showing an item
 * twice leaves one reply, and an item that was answered already is left alone. A note deleted
 * since is left out of `shown`.
 */
export const showBeingRead = {
	name: 'gitlabShowBeingRead',
	description: 'Shows the reviewer that review items on a merge request are being read',
	input: MergeRequestRef.extend({ items: z.array(ReviewItemId) }),
	output: z.object({
		shown: z.array(ReviewItemId),
		answered: z.array(ReviewItemId).describe('Items the run answered already, such as before it started over'),
	}),
}

/** A job of a pipeline that failed. */
export const JobFailure = z.object({ name: z.string(), stage: z.string(), summary: z.string(), url: z.url().optional() })
export type JobFailure = z.infer<typeof JobFailure>

/** How far the pipeline of a commit is: none yet, running, or done. */
export const PipelineStatus = z.enum(['none', 'pending', 'completed'])
export type PipelineStatus = z.infer<typeof PipelineStatus>

/**
 * Reads on the host the latest pipeline of a commit, on `ref` when one is named, and the jobs of it
 * that failed. A pipeline waiting on a manual job counts as completed: nothing runs until someone
 * starts it.
 */
export const pipelineOnCommit = {
	name: 'gitlabPipeline',
	description: 'Reads the latest pipeline of a commit on GitLab and its failed jobs',
	input: z.object({ repository: ProjectPath, sha: Sha, ref: BranchName.optional() }),
	output: z.object({
		status: PipelineStatus,
		failures: z.array(JobFailure),
		/** The pipeline, once there is one. */
		pipeline: z.object({ id: z.int(), url: z.url() }).optional(),
	}),
}

/** The kinds of package GitLab's package registry keeps that `publishedPackages` lists. */
export const PackageType = z.enum(['nuget', 'npm', 'maven', 'pypi', 'generic'])
export type PackageType = z.infer<typeof PackageType>

/** A package in GitLab's package registry. */
export const PublishedPackage = z.object({ name: z.string(), version: z.string(), url: z.url().optional() })
export type PublishedPackage = z.infer<typeof PublishedPackage>

/** Lists on the host the packages of a type that pipeline `pipeline` published to the project's registry. */
export const pipelinePackages = {
	name: 'gitlabPipelinePackages',
	description: "Lists the packages a pipeline published to a GitLab project's package registry",
	input: z.object({ repository: ProjectPath, pipeline: z.int().positive(), type: PackageType }),
	output: z.array(PublishedPackage),
}
