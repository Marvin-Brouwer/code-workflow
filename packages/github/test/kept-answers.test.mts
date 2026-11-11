import { describe, expect, test } from 'vitest'
import { keptAnswers, type KeptAnswer } from '../src/host/kept-answers.mts'

/** An answer with `body`. */
const answer = (body: string): KeptAnswer => ({ etag: '"v1"', status: 200, headers: [], body })

describe('keptAnswers', () => {
	test('forgets the least recently used answers once their bodies no longer fit, counting a touch as a use', () => {
		// Arrange
		const kept = keptAnswers('aa'.length * 2)
		kept.keep('first', answer('aa'))
		kept.keep('second', answer('bb'))

		// Act
		kept.touch('first')
		kept.keep('third', answer('cc'))

		// Assert
		expect(['first', 'second', 'third'].map((key) => kept.get(key)?.body)).toEqual(['aa', undefined, 'cc'])
	})

	test('keeps nothing of an answer larger than all it may keep', () => {
		// Arrange
		const kept = keptAnswers('aa'.length)

		// Act
		kept.keep('large', answer('bbb'))

		// Assert
		expect(kept.get('large')).toBeUndefined()
	})

	test('makes room when an answer is forgotten', () => {
		// Arrange
		const kept = keptAnswers('aa'.length)
		kept.keep('first', answer('aa'))

		// Act
		kept.forget('first')
		kept.keep('second', answer('b'))
		kept.keep('third', answer('c'))

		// Assert
		expect(['first', 'second', 'third'].map((key) => kept.get(key)?.body)).toEqual([undefined, 'b', 'c'])
	})
})
