# @mesh-flow/build

Builds a mesh-flow app into a folder the engine can deploy. CI runs it through `mesh-flow build`, and `mesh-flow dev` runs it on every change.

The app is the package whose `main` in `package.json` points at the entry file, the one that exports `defineMeshFlow`. The build:

1. bundles the entry file and everything it imports into one file, `main.mjs`, with [rolldown](https://rolldown.rs);
2. leaves out dependencies that ship native code (a node-gyp addon, prebuilt binaries, or platform packages as esbuild has), and installs those next to the bundle with npm for the sandbox's platform, so a Windows or macOS runner builds for the Linux sandbox;
3. runs the built app once in describe mode, on the building machine, and writes what it declares to `mesh-flow.json`.

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

A dependency that compiles its native code when installed can only be built on the sandbox's own platform; the build says so. An import it can't find fails the build, not the run.
