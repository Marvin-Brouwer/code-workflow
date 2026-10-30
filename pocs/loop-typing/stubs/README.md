# Stubs

Type-only stand-ins for the modules the option C sketches import but that don't exist yet, so
`tsconfig.sketches.json` can type-check the sketches without editing them.

- `connector-atlassian/jira-api.ts`, `connector-gitlab/api.ts`, `toolchain-dotnet/cli.ts`: the
  sketches' relative imports (`./jira-api`, `./api`, `./cli`), merged in through `rootDirs`.
  Their shapes are read off how the sketches use them, nothing more.
- `git.ts`: `@engine/git`.
- `entries/*.ts`: the sketches import connectors as namespaces (`import { jira } from
  '@engine/connector-atlassian'`) while each sketch module exports its members directly. These
  re-export each module under its namespace name.
