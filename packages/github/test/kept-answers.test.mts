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

	test('keeps nothing of an answer larger than all it may keep, and counts a forgotten one out', () => {
		// Arrange
		const kept = keptAnswers('aa'.length)
		kept.keep('small', answer('aa'))

		// Act
		kept.keep('large', answer('bbb'))
		kept.forget('small')
		kept.keep('again', answer('cc'))

		// Assert
		expect(['small', 'large', 'again'].map((key) => kept.get(key)?.body)).toEqual([undefined, undefined, 'cc'])
	})
})
