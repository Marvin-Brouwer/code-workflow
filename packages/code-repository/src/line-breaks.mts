/** `body` with the `\r\n` line breaks a code host's editor saves turned into `\n`. */
export function withUnixLineBreaks(body: string): string {
	return body.replaceAll('\r\n', '\n')
}
