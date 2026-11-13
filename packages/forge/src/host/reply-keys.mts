/** The marker key every reply a connector posts carries, so a look at the review never hands it back as a reviewer's. */
export const replyKey = 'reply'

/** The marker key of the reply that says `item` is being read, until the answer replaces it. */
export const seenKey = (item: string) => `seen:${item}`

/** The marker key of the plan that replaced the reply that said `item` was being read, so the answer to it is a reply of its own. */
export const plannedKey = (item: string) => `planned:${item}`

/** The marker key of an answer to `item` that is a reply of its own, so a run that starts over finds it. */
export const repliedKey = (item: string) => `replied:${item}`

/** The marker key of the answer that replaced the reply that said `item` was being read, so `item` isn't shown again. */
export const answeredKey = (item: string) => `answered:${item}`

/** The name of the marker that holds the 👀 reaction the reply that says an item is being read put on it. */
export const reactionKeyName = 'reaction'

/** The marker key, `reaction:<id>`, of 👀 reaction `reaction`. */
export const reactionKey = (reaction: number) => `${reactionKeyName}:${String(reaction)}`
