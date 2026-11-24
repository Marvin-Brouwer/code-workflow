/** The text a form holds under `name`, or `''` when it holds none, or a file. */
export function formText(form: FormData, name: string): string {
	const value = form.get(name)
	return typeof value === 'string' ? value : ''
}
