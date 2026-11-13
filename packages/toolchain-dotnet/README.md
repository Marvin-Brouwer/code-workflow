# `@mesh-flow/toolchain-dotnet`

The .NET toolchain for mesh-flow: tools an agent checks its own work with, checks for `verify` that check it again, and a function for code that moves package references. Everything runs in the sandbox with the `dotnet` of the sandbox's image, so the image needs a .NET SDK; NuGet packages come through the sandbox's package egress. The package ships no agents.

## Usage

Everything takes a checkout by where it is on disk, `{ directory }`, which a connector's checkout is, such as `gitlab.checkout`'s:

```ts
import { succeed, verify } from '@mesh-flow/core'
import { gitlab } from '@mesh-flow/gitlab'
import { dotnet } from '@mesh-flow/toolchain-dotnet'

const repository = await gitlab.checkout('team/backend/api', { branch: `feature/${story.key}` })
await dotnet.updatePackages(repository, [{ name: 'Team.Contracts', version: '2.4.0' }])

await developer.loop`
	Implement ${story} in ${repository}. Build with ${dotnet.build} and test with ${dotnet.test} until both pass,
	then hand in with ${verify(dotnet.tests(repository), dotnet.security(repository))}.
`
```

### Tools for agents

- `dotnet.build` runs `dotnet build` on a directory, or a solution or project in it, and hands back `{ succeeded, errors, warnings }`: each error with its code, file, line and column, once, though MSBuild repeats it per target framework. A failure without an error in MSBuild's form, such as a missing SDK, comes with the end of the output.
- `dotnet.test` runs `dotnet test`, all tests or those a `--filter` expression picks, and hands back the counts and each failed test with its message and stack trace. The failures are read from a TRX results file per test project rather than from the console, whose form differs per test framework. When the build fails, its errors come back instead.

### Checks for `verify`

- `dotnet.tests(repository)` runs every test, and each failed test is a finding; when the build fails, each build error is.
- `dotnet.security(repository)` restores, then lists the packages with a known vulnerability, transitive ones too (`dotnet list package --vulnerable --include-transitive`), and each is a finding with its severity and advisory link. A restore that fails fails the check, since nothing can be told about the packages then.

### Packages

`dotnet.updatePackages(repository, packages)` moves each project that references one of `packages` directly to its version, with `dotnet add package`, which writes `Directory.Packages.props` under central package management. A reference already at the version is left alone, so a rerun changes nothing; it resolves to what it changed, `{ project, name, from, to }` each. It takes what `gitlab.publishedPackages` resolves to.

### Notes

- Build servers and MSBuild node reuse are off: a server that outlives the call holds its output open. Stopping the run kills `dotnet` and everything it started.
- Test projects on Microsoft.Testing.Platform's own `dotnet test` mode take `--report-trx` rather than `--logger trx`, and aren't read yet.
- A virus scan is planned (issue #31).
