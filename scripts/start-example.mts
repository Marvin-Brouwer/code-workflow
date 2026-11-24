/**
 * Starts one example app with everything around it, for trying mesh-flow by hand from the repo root:
 * `pnpm start:github-issue`. It builds what the app and the UI need, adds the app's connectors to a
 * home of its own in `.mesh-flow/home`, then runs the engine (`mesh-flow serve`), the app's watch
 * (`mesh-flow dev`) and the UI (`mesh-flow ui`) together. Ctrl+C stops all three.
 *
 * The home stays between starts, so providers and credentials set in the UI are there next time.
 * Arguments after the app's name go to `mesh-flow serve`, such as `--backend gvisor`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = path.join(root, '.mesh-flow', 'home')
const cli = path.join(root, 'packages', 'engine', 'bin', 'mesh-flow.mts')

const [example, ...serveArguments] = process.argv.slice(2)
if (example === undefined) throw new Error('Name the example app: node scripts/start-example.mts github-issue')
const appDirectory = path.join(root, 'examples', example)

/** Runs a command to its end, with its output on this terminal. Rejects when it fails. */
function run(command: string, args: readonly string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`${command} ${args.join(' ')} failed with ${String(code)}.`))
		})
	})
}

/** Starts `mesh-flow` with `args` in `cwd`, its output lines prefixed with `name`. */
function start(name: string, args: readonly string[], cwd: string): ChildProcess {
	const child = spawn(process.execPath, [cli, '--home', home, ...args], { cwd, stdio: ['inherit', 'pipe', 'pipe'] })
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) console.log(`[${name}] ${line}`)
		})
	return child
}

/** Resolves once `child` printed a line that contains `text`, or rejects when it exits first. */
function printed(child: ChildProcess, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const look = (chunk: Buffer) => {
			if (chunk.toString('utf8').includes(text)) resolve()
		}
		child.stdout?.on('data', look)
		child.stderr?.on('data', look)
		child.on('exit', () => {
			reject(new Error('The engine stopped before it was ready.'))
		})
	})
}

/** The object under `key` in the JSON file at `file`, or an empty one when there is none. */
async function objectIn(file: string, key: string): Promise<Record<string, unknown>> {
	const json: unknown = JSON.parse(await readFile(file, 'utf8'))
	const value: unknown = typeof json === 'object' && json !== null ? Reflect.get(json, key) : undefined
	return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {}
}

/** The app's direct dependencies that are connectors: those with a `host` entry point. */
async function connectorsOf(directory: string): Promise<string[]> {
	const dependencies = await objectIn(path.join(directory, 'package.json'), 'dependencies')
	const connectors: string[] = []
	for (const name of Object.keys(dependencies)) {
		const exports = await objectIn(path.join(directory, 'node_modules', name, 'package.json'), 'exports')
		if (Object.hasOwn(exports, './host')) connectors.push(name)
	}
	return connectors
}

await run('pnpm', ['--filter', `@example/${example}...`, '--filter', '@mesh-flow/ui...', 'build'], root)
for (const connector of await connectorsOf(appDirectory))
	await run(process.execPath, [cli, '--home', home, 'connector', 'add', connector], appDirectory)

// Ctrl+C reaches every process on the terminal: each stops itself, and this waits for them.
process.on('SIGINT', () => undefined)
const engine = start('engine', ['serve', ...serveArguments], appDirectory)
await printed(engine, 'Engine ready')
const others = [start('app', ['dev'], appDirectory), start('ui', ['ui'], path.join(root, 'packages', 'ui'))]
engine.on('exit', () => {
	for (const child of others) child.kill('SIGINT')
})
