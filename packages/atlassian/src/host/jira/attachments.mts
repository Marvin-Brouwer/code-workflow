import type { IssueAttachment } from '../../tools/issue-tools.mts'
import type { RawAttachment } from './raw-issue.mts'

/** The largest image brought into the sandbox. A larger one keeps only its link. */
export const maxImageBytes = 5 * 1024 * 1024

/** The most bytes of images one issue brings, so a call's answer stays a size the gateway carries well. */
export const maxImageBytesPerIssue = 20 * 1024 * 1024

/** Reads an attachment's bytes from the site, signed in; `undefined` when it couldn't be read. */
export type Download = (url: string, abortSignal: AbortSignal) => Promise<Uint8Array | undefined>

/** Where an attachment goes next to `<key>.md`: a folder named after the issue, the file named by its id and name. */
export function attachmentFile(key: string, attachment: RawAttachment): string {
	return `${key}/${attachment.id}-${attachment.filename.replaceAll(/[^\w.-]/g, '_')}`
}

/**
 * The issue's attachments as the sandbox gets them: each image, up to {@link maxImageBytes} and
 * {@link maxImageBytesPerIssue} in all, with its bytes; everything else, and an image that couldn't
 * be read, with only its URL. Only files on the site itself are read, so the token never goes
 * elsewhere.
 */
export async function issueAttachments(
	key: string,
	siteUrl: string,
	attachments: readonly RawAttachment[],
	download: Download,
	abortSignal: AbortSignal,
): Promise<IssueAttachment[]> {
	const site = new URL(siteUrl).origin
	let budget = maxImageBytesPerIssue
	const brought: IssueAttachment[] = []
	for (const attachment of attachments) {
		const url = new URL(attachment.content, siteUrl)
		const listed = { id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, url: url.href }
		const worthBringing = attachment.mimeType.startsWith('image/') && attachment.size <= Math.min(maxImageBytes, budget)
		const bytes = worthBringing && url.origin === site ? await download(url.href, abortSignal) : undefined
		if (bytes === undefined || bytes.byteLength > Math.min(maxImageBytes, budget)) {
			brought.push(listed)
			continue
		}
		budget -= bytes.byteLength
		brought.push({ ...listed, file: attachmentFile(key, attachment), data: Buffer.from(bytes).toString('base64') })
	}
	return brought
}

/** The id of the attachment an image in rendered rich text shows, by its address: its content or its thumbnail. */
export function attachmentIdOf(src: string): string | undefined {
	return /\/(?:attachment(?:\/content)?|thumbnail)\/(\d+)(?:[/?#]|$)/.exec(src)?.[1]
}
