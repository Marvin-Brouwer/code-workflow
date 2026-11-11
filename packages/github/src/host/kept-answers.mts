/** What is kept of an answer to a read: its ETag, to ask with next time, and what to hand back when it didn't change. */
export interface KeptAnswer {
	readonly etag: string
	readonly status: number
	readonly headers: [string, string][]
	readonly body: string
}

/** Answers kept in memory up to a total body size, the least recently used going first. */
export interface KeptAnswers {
	/** The answer kept for `key`, without counting as a use. */
	get(key: string): KeptAnswer | undefined
	/** Keeps `answer` as the most recently used, forgetting the least recently used ones until all fit. */
	keep(key: string, answer: KeptAnswer): void
	/** Marks the answer as used again, so it's forgotten last. */
	touch(key: string): void
	/** Forgets the answer kept for `key`, if any. */
	forget(key: string): void
}

/** Kept answers whose bodies add up to `maxCharacters` at most. */
export function keptAnswers(maxCharacters: number): KeptAnswers {
	// A Map iterates in the order its keys went in, so the first key is the least recently used.
	const kept = new Map<string, KeptAnswer>()
	let keptCharacters = 0
	const forget = (key: string) => {
		keptCharacters -= kept.get(key)?.body.length ?? 0
		kept.delete(key)
	}
	const keep = (key: string, answer: KeptAnswer) => {
		forget(key)
		kept.set(key, answer)
		keptCharacters += answer.body.length
		for (const oldest of kept.keys()) {
			if (keptCharacters <= maxCharacters) break
			forget(oldest)
		}
	}
	return Object.freeze<KeptAnswers>({
		get: (key) => kept.get(key),
		keep,
		touch(key) {
			const answer = kept.get(key)
			if (answer !== undefined) keep(key, answer)
		},
		forget,
	})
}
