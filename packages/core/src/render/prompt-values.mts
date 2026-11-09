import type { AnyTool } from '../tool/tool.mts'

/** What the compiler says about a value that can't go into a prompt: the type it wants instead names the reason. */
export interface NotForPrompts<Reason extends string> {
	readonly 'This value cannot go into a prompt': Reason
}

type IsAny<T> = 0 extends 1 & T ? true : false

/**
 * A value as a prompt takes it. Tools, exits, limits, nested prompts, values with `[toPrompt]`,
 * primitives, dates and plain data go in. A promise (an `await` forgotten), a function that isn't a
 * tool, or a symbol would render as `{}` or as a name, so the compiler refuses them.
 */
export type PromptValue<Value> =
	IsAny<Value> extends true
		? Value
		: Value extends PromiseLike<unknown>
			? NotForPrompts<'a Promise: await it first'>
			: Value extends AnyTool
				? Value
				: Value extends (...args: never[]) => unknown
					? NotForPrompts<'a function: call it, or make it a tool'>
					: Value extends symbol
						? NotForPrompts<'a symbol'>
						: Value

/**
 * The values of a template, each checked with {@link PromptValue}. Used as `Values & PromptValues<Values>`,
 * so `Values` is still inferred from the arguments and a refused value fails to type check.
 */
export type PromptValues<Values extends readonly unknown[]> = { readonly [Index in keyof Values]: PromptValue<Values[Index]> }
