/**
 * The .NET toolchain, as workflow code uses it: tools for agents to check their own work
 * (`dotnet.build`, `dotnet.test`), checks for `verify` that check it again (`dotnet.tests`,
 * `dotnet.security`), and a function for code (`dotnet.updatePackages`). Everything runs in the
 * sandbox, with the SDK of the sandbox's image; the package ships no agents.
 *
 * @module
 */
export * as dotnet from '../dotnet.mts'
