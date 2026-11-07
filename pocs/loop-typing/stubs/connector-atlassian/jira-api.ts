export interface Story {
	readonly key: string
	readonly summary: string
	readonly path: string
}

export declare const api: {
	dump(key: string): Promise<Story>
	transition(story: Story, status: string): Promise<void>
	comment(story: Story, text: string, options: { deduplicate: boolean }): Promise<void>
	search(jql: string): Promise<readonly { key: string; summary: string }[]>
	dumpMarkdown(key: string): Promise<string>
}
