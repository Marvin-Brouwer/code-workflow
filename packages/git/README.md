# `@mesh-flow/git`

Git for mesh-flow, on the `git` the machine has. One client per repository; every command on it is a value that runs when awaited, says what it would run, or is tried best-effort. Credentials go through the environment, never through the arguments, and a stop kills git and the helpers it started.

It's what the connectors build on, on the host and in the sandbox alike. Workflow code can use it directly for a checkout the workflow owns.

## Usage

### A client for a repository

```ts
import { gitClient } from '@mesh-flow/git'

const git = gitClient({
	cwd: '/work/app',
	gitConfig: { 'user.name': 'mesh-flow', 'user.email': 'mesh-flow@users.noreply.github.com' },
	abortSignal,
})

await git.fetch('origin', ['main'], { quiet: true })
await git.checkoutOrCreate('fix/7') // from origin/fix/7 when the remote has it, else from origin/<default branch>
await git.add()
await git.commit({ message: 'Fix the login', quiet: true })
const { stdout } = await git.revParse('HEAD')
```

`gitConfig` goes on every command as `-c key=value` and is never written to the repository; `setIdentity` is the one that writes `.git/config`. `abortSignal` is required: aborting it kills whatever command runs, and the call rejects with the signal's reason.

### What a command does depends on how it's used

```ts
await git.push('origin', ['fix/7'], { quiet: true })      // runs; throws on a non-zero exit, naming the command
const asked = await git.showRef('refs/heads/fix/7').run() // runs; hands the exit back: asked.ok, asked.exitCode, asked.stderr
await git.rebaseAbort().attempt()                         // runs; swallows the result and any error, for cleanup
const line = String(git.rebase('origin/main'))            // 'git rebase origin/main', nothing runs
```

The questions a workflow asks are there as functions: `hasRef`, `hasLocalBranch`, `hasRemoteBranch`, `defaultBranch` (what the remote recorded, else `main` or `master`), `currentBranch`, `checkoutOrCreate`, `hasChanges` (staged or not), `dirtyFiles` (`git status --porcelain=v1` entries, paths unquoted), `conflictedFiles`, `discardChanges` (back to HEAD; untracked files stay), `setIdentity`.

### A credential, for the host

```ts
import { basicAuthHeaderEnv, gitClient } from '@mesh-flow/git'

const git = gitClient({ cwd: clone, env: basicAuthHeaderEnv('x-access-token', token), abortSignal })
await git.fetch('origin', ['+refs/heads/*:refs/heads/*'], { prune: true, quiet: true })
```

The header travels as `GIT_CONFIG_*` environment, so it's neither in a process list nor in `.git/config`, and the credential helper is off. Only the host does this: a sandbox never holds a credential ([design section 7](../../docs/design.md#7-credentials-and-the-gateway)).

### The commands

`commands` holds the arguments of every command the client knows, and `formatCommand` renders arguments as a shell line. A new command goes in `commands` once, and the client has it. `rawGit` is every command rendered without a client: `rawGit.rebase('origin/main')` is `'git rebase origin/main'`, for a prompt written where no checkout is at hand.

## Development

```sh
pnpm --filter @mesh-flow/git typecheck
pnpm --filter @mesh-flow/git test
pnpm --filter @mesh-flow/git build
```

The tests need `git` on the machine. They cover the stop: a fetch from a server that never answers settles within seconds of the abort.

On Linux and macOS git runs in a process group of its own, so a stop reaches the helpers it started. The other side of that: a process that ends without aborting the signal, such as one that crashes, leaves a running git going until it finishes. Abort the signal on shutdown.
