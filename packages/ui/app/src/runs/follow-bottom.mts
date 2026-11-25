/** How close to the bottom still counts as at the bottom, so a pixel off doesn't stop following. */
const bottomSlackPx = 48

/** Whether the page is scrolled to its bottom. */
function atBottom(): boolean {
	return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - bottomSlackPx
}

/** Scrolls the page to its bottom. */
function toBottom(): void {
	window.scrollTo({ top: document.documentElement.scrollHeight })
}

/** Keeps a page at its bottom: see {@link followBottom}. */
export interface BottomFollower {
	/** Scrolls to the bottom if the page still follows it: call after each change is drawn. */
	readonly follow: () => void
	/** Scrolls to the bottom and follows it again, as after someone scrolled back down. */
	readonly tail: () => void
}

/**
 * Keeps the page at its bottom as a run's steps come in, and as anything else on it grows, until
 * someone scrolls up to read; once they scroll back to the bottom, or `tail` is called, it follows
 * again. `following` hears each change.
 *
 * ```ts
 * const bottom = followBottom(abortSignal, (following) => {
 * 	tailButton.hidden = following
 * })
 * steps.replaceChildren(...bars)
 * bottom.follow()
 * ```
 */
export function followBottom(abortSignal: AbortSignal, following: (isFollowing: boolean) => void): BottomFollower {
	let isFollowing = true
	let lastScrollY = window.scrollY
	// Only scrolling up stops following: content that grew between a scroll to the bottom and its
	// scroll event leaves the page above the bottom without anyone having scrolled.
	window.addEventListener(
		'scroll',
		() => {
			const scrolledUp = window.scrollY < lastScrollY
			lastScrollY = window.scrollY
			const now = atBottom() || (isFollowing && !scrolledUp)
			if (now === isFollowing) return
			isFollowing = now
			following(isFollowing)
		},
		{ passive: true, signal: abortSignal },
	)
	const follow = () => {
		if (isFollowing) toBottom()
	}
	// What grows after a draw, such as the run's input once it's read, is followed too.
	const growing = new ResizeObserver(follow)
	growing.observe(document.body)
	abortSignal.addEventListener('abort', () => {
		growing.disconnect()
	})
	return {
		follow,
		tail: () => {
			isFollowing = true
			following(true)
			toBottom()
		},
	}
}
