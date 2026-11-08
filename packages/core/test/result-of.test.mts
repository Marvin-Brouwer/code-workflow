import { describe, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import { check } from '../src/check/check.mts'
import type { ResultOf } from '../src/exits/result-of.mts'
import type { fail } from '../src/exits/fail.mts'
import { propose } from '../src/exits/propose.mts'
import { succeed } from '../src/exits/succeed.mts'
import { verify } from '../src/exits/verify.mts'
import type { WorkspaceFolder } from '../src/workspace/workspace-folder.mts'
import { workspace } from '../src/workspace/workspace.mts'

const Plan = z.object({ path: z.string() })
const tests = check('tests', async () => [])

describe('ResultOf', () => {
	test('is the final text without exits', () => {
		expectTypeOf<ResultOf<[string, number]>>().toEqualTypeOf<string>()
	})

	test('is the schema output of succeed and propose', () => {
		const succeeds = succeed(Plan)
		const proposes = propose(Plan)
		expectTypeOf<ResultOf<[typeof succeeds]>>().toEqualTypeOf<{ path: string }>()
		expectTypeOf<ResultOf<[typeof proposes, typeof fail]>>().toEqualTypeOf<{ path: string }>()
	})

	test('is the folder for succeed(folder)', () => {
		const exit = succeed(workspace.folder('research'))
		expectTypeOf<ResultOf<[typeof exit]>>().toEqualTypeOf<WorkspaceFolder>()
	})

	test('is nothing for verify alone, also next to fail', () => {
		const gate = verify(tests)
		expectTypeOf<ResultOf<[typeof gate]>>().toBeVoid()
		expectTypeOf<ResultOf<[typeof gate, typeof fail]>>().toBeVoid()
	})

	test('is the result next to verify', () => {
		const gate = verify(tests)
		const exit = succeed(Plan)
		expectTypeOf<ResultOf<[typeof gate, typeof exit]>>().toEqualTypeOf<{ path: string }>()
	})

	test('is the final text with only fail', () => {
		expectTypeOf<ResultOf<[typeof fail]>>().toEqualTypeOf<string>()
	})

	test('does not take a look-alike object for an exit', () => {
		expectTypeOf<ResultOf<[{ kind: 'exit' }]>>().toEqualTypeOf<string>()
	})
})
