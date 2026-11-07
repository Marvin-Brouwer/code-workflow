#!/usr/bin/env node
/**
 * The `mesh-flow` command. Not for importing: it runs the command line with this process's
 * arguments.
 *
 * @module
 */
import { main } from '../cli/main.mts'

await main(process.argv)
