/** What a tool or check gets when called from code, with a signal nothing aborts. */
export function toolContext(): { readonly abortSignal: AbortSignal } {
	return { abortSignal: new AbortController().signal }
}
