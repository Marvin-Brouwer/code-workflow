import type { IssueAttachment } from '../../tools/issue-tools.mts'
import type { RawAttachment } from './raw-issue.mts'

/** The largest image brought into the sandbox. A larger one keeps only its link. */
export const maxImageBytes = 5 * 1024 * 1024

/** The most bytes of images one issue brings, so a call's answer stays a size the gateway carries well. */
export const maxImageBytesPerIssue = 20 * 1024 * 1024

/** Reads an image attachment's bytes from the site, signed in; `undefined` when it couldn't be read as an image of up to `maxBytes`. */
export type Download = (url: string, maxBytes: number, abortSignal: AbortSignal) => Promise<Uint8Array | undefined>

/** What a file name keeps of an attachment's name: anything else becomes `_`, so the name can't leave its folder. */
const unsafeFileNameCharacters = /[^\w.-]/g

/** What Jira's attachment ids look like: they go into a path, so anything else is never written. */
const numericAttachmentId = /^\d+$/

/** Where an attachment goes next to `<key>.md`: a folder named after the issue, the file named by its id and name. */
export function attachmentFile(key: string, attachment: RawAttachment): string {
	return `${key}/${attachment.id}-${attachment.filename.replaceAll(unsafeFileNameCharacters, '_')}`
}

/**
 * The issue's attachments as the sandbox gets them: each image, up to {@link maxImageBytes} and
 * {@link maxImageBytesPerIssue} in all, with its bytes; everything else, and an image that couldn't
 * be read, with only its URL. Only files on the site itself are read, so the token never goes
 * elsewhere. An attachment whose address isn't one is left out.
 */
export async function issueAttachments(
	key: string,
	siteUrl: string,
	attachments: readonly RawAttachment[],
	download: Download,
	abortSignal: AbortSignal,
): Promise<IssueAttachment[]> {
	const site = new URL(siteUrl).origin
	let remainingBytes = maxImageBytesPerIssue
	const listed: IssueAttachment[] = []
	for (const attachment of attachments) {
		const url = URL.parse(attachment.content, siteUrl)
		if (url === null) continue
		const link = { id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, url: url.href }
		const allowedBytes = Math.min(maxImageBytes, remainingBytes)
		const worthBringing =
			attachment.mimeType.startsWith('image/') &&
			numericAttachmentId.test(attachment.id) &&
			(attachment.size ?? 0) <= allowedBytes &&
			url.origin === site
		const bytes = worthBringing ? await download(url.href, allowedBytes, abortSignal) : undefined
		if (bytes === undefined) {
			listed.push(link)
			continue
		}
		remainingBytes -= bytes.byteLength
		listed.push({ ...link, file: attachmentFile(key, attachment), data: Buffer.from(bytes).toString('base64') })
	}
	return listed
}

/** The id of the attachment an image in rendered rich text shows, by its address: its content or its thumbnail. */
export function attachmentIdOf(src: string): string | undefined {
	return /\/(?:attachment(?:\/content)?|thumbnail)\/(\d+)(?:[/?#]|$)/.exec(src)?.[1]
}
