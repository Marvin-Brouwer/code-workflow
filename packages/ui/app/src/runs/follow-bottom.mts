/** How close to the bottom still counts as at the bottom, so a pixel off doesn't stop following. */
const bottomSlack = 48

/** Whether the page is scrolled to its bottom. */
function atBottom(): boolean {
	return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - bottomSlack
}

/**
 * Keeps the page at its bottom as a run's steps come in, and as anything else on it grows, until
 * someone scrolls up to read; once they scroll back to the bottom, it follows again. Call what it
 * returns after each change is drawn.
 *
 * ```ts
 * const follow = followBottom(signal)
 * steps.replaceChildren(...bars)
 * follow()
 * ```
 */
export function followBottom(abortSignal: AbortSignal): () => void {
	let following = true
	// Content that grows doesn't scroll, so only someone scrolling, or the scroll below, changes this.
	window.addEventListener(
		'scroll',
		() => {
			following = atBottom()
		},
		{ passive: true, signal: abortSignal },
	)
	const follow = () => {
		if (following) window.scrollTo({ top: document.documentElement.scrollHeight })
	}
	// What grows after a draw, such as the run's input once it's read, is followed too.
	const growing = new ResizeObserver(follow)
	growing.observe(document.body)
	abortSignal.addEventListener('abort', () => {
		growing.disconnect()
	})
	return follow
}
