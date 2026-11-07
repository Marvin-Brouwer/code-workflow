# Stubs

Type-only stand-ins for the modules the option C sketches import but that don't exist yet, so
`tsconfig.sketches.json` can type-check the sketches without editing them.

- `connector-atlassian/jira-api.mts`, `connector-gitlab/api.mts`, `toolchain-dotnet/cli.mts`: the
  sketches' relative imports (`./jira-api`, `./api`, `./cli`), merged in through `rootDirs`.
  Their shapes are read off how the sketches use them, nothing more.
- `git.mts`: `@mesh-flow/git`.
