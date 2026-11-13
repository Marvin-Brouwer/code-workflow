# `@mesh-flow/toolchain-dotnet`

The .NET toolchain for mesh-flow: tools an agent checks its own work with, checks for `verify` that check it again, and a function for code that moves package references. Everything runs in the sandbox with the `dotnet` of the sandbox's image, so the image needs a .NET SDK; NuGet packages come through the sandbox's package egress. The package ships no agents.

## Usage

Everything takes a checkout by where it is on disk, `{ directory }`, which a connector's checkout is, such as `gitlab.checkout`'s:

```ts
import { verify, type Agent } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab'
import { dotnet } from '@mesh-flow/toolchain-dotnet'

declare const developer: Agent
declare const story: { readonly key: string }

const repository = await gitlab.checkout({ repository: 'team/backend/api', branch: `feature/${story.key}` })
await dotnet.updatePackages(repository, [{ name: 'Team.Contracts', version: '2.4.0' }])

await developer.loop`
	Implement ${story} in ${repository}. Build with ${dotnet.build} and test with ${dotnet.test} until both pass,
	then hand in with ${verify(dotnet.testsPass(repository), dotnet.security(repository))}.
`
```

### Tools for agents

- `dotnet.build` runs `dotnet build` on a directory, or a solution or project in it, and hands back `{ succeeded, errors, warnings }`: each error with its code, file, line and column, once, though MSBuild repeats it per target framework. A failure without an error in MSBuild's form, such as a missing SDK, comes with the end of the output.
- `dotnet.test` runs `dotnet test`, all tests or those a `--filter` expression picks, and hands back the counts and each failed test with its message and stack trace: one that timed out or was aborted too, and each failed row of a data-driven test. The failures are read from a TRX results file per test project rather than from the console, whose form differs per test framework. When the build fails, its errors come back instead.

### Checks for `verify`

- `dotnet.testsPass(repository)` runs every test, and each failed test is a finding; when the build fails, each build error is.
- `dotnet.security(repository)` restores, then lists the packages with a known vulnerability, transitive ones too (`dotnet list package --vulnerable --include-transitive`), and each is a finding with its severity and advisory link. A problem the list reports, such as a source without vulnerability data, and a restore that fails, fail the check: nothing can be told about the packages then, and an agent can't fix the environment.

Both take `{ target }` as a second argument, the solution or project relative to the checkout, for a checkout without one at its root or with more than one there, such as an `.sln` beside its `.slnx`: `dotnet` looks only at the root, and fails on more than one.

```ts
await developer.loop`Implement ${story} in ${repository}, then hand in with ${verify(dotnet.testsPass(repository, { target: 'src/Api.slnx' }))}.`
```

### Packages

`dotnet.updatePackages(repository, packages)` moves each project that references one of `packages` directly to its version, with `dotnet add package`, which writes `Directory.Packages.props` under central package management. A reference already at the version is left alone, so a rerun changes nothing; it resolves to what it changed, `{ project, name, from, to }` each. It takes what `gitlab.publishedPackages` resolves to, and `{ target }` as the checks do.

### Notes

- Build servers and MSBuild node reuse are off: a server that outlives the call holds its output open. Stopping the run kills `dotnet` and everything it started, outright after two seconds, and on Linux and macOS also what outlives `dotnet` itself.
- `dotnet` runs in the same directory take turns, since they share `obj` and `bin`: under `verify(dotnet.testsPass(repository), dotnet.security(repository))`, the test run and the security check's restore and list never run at once. A stopped run is waited for until `dotnet` is gone.
- Test projects on Microsoft.Testing.Platform's own `dotnet test` mode take `--report-trx` rather than `--logger trx`, and aren't read yet.
- A virus scan is planned (issue #31).
