/** An error or warning as MSBuild reports it, such as a compiler error on a line. */
export interface Diagnostic {
	readonly severity: 'error' | 'warning'
	/** Such as `CS1002` or `NU1101`; absent when the tool gave none. */
	readonly code?: string
	readonly message: string
	/** The file it is about, as MSBuild names it, and where in it. */
	readonly file?: string
	readonly line?: number
	readonly column?: number
	/** The project it was reported for. */
	readonly project?: string
}

/**
 * MSBuild's canonical form: `origin: [subcategory] error|warning [code]: text [project]`, where the
 * origin is a file with an optional `(line,column)`, or a tool's name.
 */
const msbuildDiagnosticLine =
	/^\s*(?:(?<origin>.+?)(?:\((?<line>\d+)(?:,(?<column>\d+))?(?:,\d+,\d+)?\))?\s*:\s*)?(?:[\w ]+ )?(?<severity>error|warning)\s*(?<code>[A-Za-z]+\d+)?\s*:\s*(?<message>.*?)(?:\s+\[(?<project>[^\]]+)\])?\s*$/

/**
 * The diagnostics in MSBuild's output, each once: MSBuild repeats them per target framework and in
 * its summary, so the same one twice is one.
 */
export function diagnosticsIn(output: string): Diagnostic[] {
	const seen = new Set<string>()
	const found: Diagnostic[] = []
	for (const line of output.split(/\r?\n/)) {
		const groups = msbuildDiagnosticLine.exec(line)?.groups
		if (groups?.severity !== 'error' && groups?.severity !== 'warning') continue
		const diagnostic: Diagnostic = {
			severity: groups.severity,
			message: groups.message ?? '',
			...(groups.code === undefined ? {} : { code: groups.code }),
			...(groups.origin === undefined ? {} : { file: groups.origin.trim() }),
			...(groups.line === undefined ? {} : { line: Number(groups.line) }),
			...(groups.column === undefined ? {} : { column: Number(groups.column) }),
			...(groups.project === undefined ? {} : { project: groups.project }),
		}
		const key = [diagnostic.severity, diagnostic.code, diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message].join('|')
		if (seen.has(key)) continue
		seen.add(key)
		found.push(diagnostic)
	}
	return found
}

/** A diagnostic on one line, as a finding or an agent reads it: `file(line,column): CS1002: message`. */
export function diagnosticLine(diagnostic: Diagnostic): string {
	const { file, line, column } = diagnostic
	const atColumn = column === undefined ? '' : `,${String(column)}`
	const position = line === undefined ? '' : `(${String(line)}${atColumn})`
	const where = file === undefined ? '' : `${file}${position}: `
	return `${where}${diagnostic.code === undefined ? '' : `${diagnostic.code}: `}${diagnostic.message}`
}
