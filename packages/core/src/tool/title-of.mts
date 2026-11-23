/**
 * The line a tool's `describe` gives for a call, or `undefined` without one. A `describe` that
 * throws only loses the title: the call did its work, so it doesn't fail for a line of text, and
 * the run view titles it by the tool's name.
 */
export function titleOf<Input, Output>(
	describe: ((input: Input, output: Output) => string) | undefined,
	input: Input,
	output: Output,
): string | undefined {
	if (describe === undefined) return undefined
	try {
		return describe(input, output)
	} catch {
		return undefined
	}
}
