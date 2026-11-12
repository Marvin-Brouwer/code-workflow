# @mesh-flow/build

Builds a mesh-flow app into a folder the engine can deploy. CI runs it through `mesh-flow build`, and `mesh-flow dev` runs it on every change.

The app is the package whose `main` in `package.json` points at the entry file, the one that exports `defineMeshFlow`. The build:

1. bundles the entry file and everything it imports into one file, `main.mjs`, with [rolldown](https://rolldown.rs), and a source map next to it, `main.mjs.map`, that names the files relative to the repository (an installed package's from its name on). Loops are keyed by their call site in the source through it, so a rebuild that moves the bundle's lines doesn't break a run's resume;
2. leaves out dependencies that ship native code (a node-gyp addon, prebuilt binaries, or platform packages as esbuild has), found also where pnpm keeps them;
3. runs the bundle once in describe mode, on the building machine, from inside the repository so those dependencies load as installed there, and writes what it declares to `mesh-flow.json`. The app exits once it has described itself;
4. installs the native dependencies next to the bundle with npm, for the sandbox's platform (Linux with glibc), so a Windows or macOS runner builds for the Linux sandbox.

The sandbox then only runs `node main.mjs`: no setup step, no install, and the engine never has to run the app to learn what it declares.

```ts
import { buildApp } from '@mesh-flow/build'

const manifest = await buildApp({
	directory: process.cwd(),
	out: '.mesh-flow/app',
	platform: { os: 'linux', cpu: 'x64' },
	abortSignal: AbortSignal.timeout(5 * 60_000),
})
console.log(manifest.description.triggers)
```

A dependency that compiles its native code when installed can only be built on the sandbox's own platform; the build says so. An import it can't find fails the build, not the run. `out` is emptied first, so it can't be the repository or a folder that holds it.
