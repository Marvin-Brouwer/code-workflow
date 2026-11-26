/** How close to the bottom still counts as at the bottom, so a pixel off doesn't stop following. */
const bottomSlackPx = 48

/** Whether the page is scrolled to its bottom. */
function atBottom(): boolean {
	return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - bottomSlackPx
}

/**
 * Keeps the page at its bottom as a run's steps come in, and as anything else on it grows, until
 * someone scrolls up to read; once they scroll back to the bottom, it follows again. Call what it
 * returns after each change is drawn.
 *
 * ```ts
 * const follow = followBottom(abortSignal)
 * steps.replaceChildren(...bars)
 * follow()
 * ```
 */
export function followBottom(abortSignal: AbortSignal): () => void {
	let following = true
	let lastScrollY = window.scrollY
	// Only scrolling up stops following: content that grew between a scroll to the bottom and its
	// scroll event leaves the page above the bottom without anyone having scrolled.
	window.addEventListener(
		'scroll',
		() => {
			const scrolledUp = window.scrollY < lastScrollY
			lastScrollY = window.scrollY
			if (atBottom()) following = true
			else if (scrolledUp) following = false
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
