/** The prefixes GitLab marks a draft merge request with, in its title. */
const draftPrefix = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-)\s*/i

/** A title without its draft prefix, for comparing what was written with what was asked for. */
export function withoutDraftPrefix(title: string): string {
	return title.replace(draftPrefix, '')
}

/**
 * `title` as it is written over `current`: with the draft prefix `current` has, so writing a title
 * never marks a draft merge request ready, which only a person does.
 */
export function keepingDraft(current: string, title: string): string {
	const prefix = draftPrefix.exec(current)?.[0]
	return prefix === undefined || draftPrefix.test(title) ? title : `${prefix}${title}`
}
